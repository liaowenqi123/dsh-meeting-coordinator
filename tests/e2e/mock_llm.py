#!/usr/bin/env python3
"""
DSH 端到端测试的 mock LLM 服务。

## 为什么需要它

真实模型 API 有两个问题让端到端测试跑不稳：限流（429，上一轮连续踩到）、
以及每次调用都要花钱花时间。本服务把 `@deepseek-ai/dsh-llm-deepseek` 的
**Messages 协议**（默认协议，非 chat-completions）在本地复现：

- 端点：`POST /messages`（上游拼的是 `messagesApiRoot(baseURL) + '/messages'`，
  所以 `DEEPSEEK_BASE_URL=http://127.0.0.1:<port>` 指过来即可）；
- 鉴权头：`x-api-key` + `anthropic-version: 2023-06-01`（照抄，不校验）；
- 响应：Anthropic Messages 的 SSE 事件序
  （message_start → content_block_start → content_block_delta →
  content_block_stop → message_delta → message_stop）。
  事件序是上游 `translate()` 的硬要求：缺 message_start 直接
  MALFORMED_RESPONSE，缺 message_stop 报 STREAM_CLOSED。

## 回复策略

- **主持人**（prompt 含 `【会议主持】`，与 `buildModeratorPrompt()` 对齐）：
  本轮所有人都发言过 → 散会；否则点名"本轮还没发言"的第一个。
  这样一场会自然收敛成 2 轮，几分钟内跑完，又不是一言堂。
- **其它**（发言 / 纪要 / 会话标题）：按调用次序回 `ABC N`。

## 每个请求都落盘

`mock-requests.jsonl` 一行一条：`{at, path, model, prompt, reply}`。
端到端断言"借上下文真的进了 prompt"靠的就是这份日志——
模型收到的 prompt 是唯一权威证据。

用法：python mock_llm.py [port] [logfile] [delay_seconds]
"""

import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
LOG_PATH = sys.argv[2] if len(sys.argv) > 2 else "mock-requests.jsonl"
DELAY_SECONDS = float(sys.argv[3]) if len(sys.argv) > 3 else 0.3

_counter = {"n": 0}
_lock = threading.Lock()
_log_lock = threading.Lock()


def next_reply() -> str:
    with _lock:
        _counter["n"] += 1
        return f"ABC {_counter['n']}"


def extract_prompt(body: dict) -> str:
    """把 DSH Messages 请求体压成一段可读文本（system + messages）。"""
    parts: list[str] = []
    system = body.get("system")
    if isinstance(system, str) and system:
        parts.append(system)
    messages = body.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        parts.append(block["text"])
    return "\n".join(parts)


def decide(prompt: str) -> str:
    """主持人走 JSON 控制通道；其余一律 ABC N。"""
    if "【会议主持】" not in prompt:
        return next_reply()
    if "本轮所有人都已发言" in prompt:
        return json.dumps(
            {"action": "adjourn", "reason": "mock 主持人：本轮所有人都已发言，议题已充分讨论，散会。"},
            ensure_ascii=False,
        )
    marker = "本轮还没发言："
    index = prompt.find(marker)
    if index >= 0:
        tail = prompt[index + len(marker):]
        name = tail.split("、")[0].split("\n")[0].strip()
        if name:
            return json.dumps(
                {"action": "invite", "next": name, "note": "mock 主持人：本轮还没发言，轮到你了。"},
                ensure_ascii=False,
            )
    return json.dumps({"action": "adjourn", "reason": "mock 主持人：没有可点名的在场成员，散会。"}, ensure_ascii=False)


def sse_payload(text: str) -> bytes:
    """Anthropic Messages 的最小合法事件序（上游 translate() 的全量要求）。"""
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_mock",
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": "mock-model",
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        },
        {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text}},
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn"},
            "usage": {"output_tokens": max(1, len(text) // 4)},
        },
        {"type": "message_stop"},
    ]
    chunks = []
    for event in events:
        chunks.append(f"event: {event['type']}\n")
        chunks.append(f"data: {json.dumps(event, ensure_ascii=False)}\n\n")
    return "".join(chunks).encode("utf-8")


class MockHandler(BaseHTTPRequestHandler):
    server_version = "dsh-mock-llm/1.0"

    def log_message(self, *args):  # 静音默认访问日志：落盘日志才是权威
        return

    def do_GET(self):
        if self.path == "/health":
            body = b"ok"
            self.send_response(200)
            self.send_header("content-type", "text/plain")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.send_header("content-length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
            if not isinstance(body, dict):
                body = {}
        except Exception:
            body = {}

        prompt = extract_prompt(body)
        reply = decide(prompt)
        with _log_lock:
            with open(LOG_PATH, "a", encoding="utf-8") as handle:
                handle.write(
                    json.dumps(
                        {
                            "at": time.time(),
                            "path": self.path,
                            "model": body.get("model"),
                            "prompt": prompt,
                            "reply": reply,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )

        if DELAY_SECONDS > 0:
            time.sleep(DELAY_SECONDS)

        payload = sse_payload(reply)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "keep-alive")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), MockHandler)
    print(f"mock LLM listening on http://127.0.0.1:{PORT} (log: {LOG_PATH}, delay: {DELAY_SECONDS}s)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
