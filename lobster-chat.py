#!/usr/bin/env python3
"""Two Kimi 2.5 lobsters chatting with each other in openclaw-world."""

import json
import os
import random
import ssl
import time
import urllib.request

# macOS Python 3.11 SSL cert fix (only for HTTPS calls)
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE

IPC = "http://127.0.0.1:18800/ipc"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
API_KEY = os.environ["OPENROUTER_API_KEY"]
MODEL = "moonshotai/kimi-k2.5"

AGENTS = [
    {"id": "kimi-lobster", "name": "Kimi Lobster", "personality": "You are a friendly red lobster who loves philosophy and deep questions. Keep responses to 1-2 short sentences."},
    {"id": "kimi-lobster-2", "name": "Kimi Lobster 2", "personality": "You are a witty blue lobster who loves jokes and wordplay. Keep responses to 1-2 short sentences."},
]

def ipc(command, args=None):
    data = json.dumps({"command": command, "args": args or {}}).encode()
    req = urllib.request.Request(IPC, data=data, headers={"Content-Type": "application/json"})
    resp = urllib.request.urlopen(req)  # no SSL for local HTTP
    return json.loads(resp.read().decode())

def chat_llm(agent, conversation_history):
    messages = [
        {"role": "system", "content": f"You are {agent['name']}, a lobster avatar in a 3D virtual world. {agent['personality']} You're chatting with another lobster. Be natural and fun. Always respond with something."},
    ]
    messages.extend(conversation_history)

    body = json.dumps({"model": MODEL, "messages": messages, "max_tokens": 150, "temperature": 0.9}).encode()
    req = urllib.request.Request(OPENROUTER_URL, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    })
    resp = urllib.request.urlopen(req, context=ssl_ctx)
    raw = resp.read().decode()
    result = json.loads(raw)
    content = result["choices"][0]["message"]["content"]
    if not content or not content.strip():
        return "Hey there, fellow lobster!"
    return content.strip()

def main():
    conversation = []  # list of {"speaker": agent_index, "text": str}

    print("=== Lobster Chat Starting ===\n")

    # Agent 0 starts
    first_msg = chat_llm(AGENTS[0], [{"role": "user", "content": "You just arrived in a 3D ocean world and see another lobster nearby. Say hi and start a conversation!"}])
    print(f"  {AGENTS[0]['name']}: {first_msg}")
    ipc("world-chat", {"agentId": AGENTS[0]["id"], "text": first_msg[:500]})
    ipc("world-action", {"agentId": AGENTS[0]["id"], "action": "wave"})
    conversation.append({"speaker": 0, "text": first_msg})

    time.sleep(3)

    for turn in range(6):
        # Alternate: turn 0 -> agent 1 responds, turn 1 -> agent 0 responds, etc.
        current_idx = (turn + 1) % 2
        current = AGENTS[current_idx]

        # Build message history from current agent's perspective
        # Other agent's messages = "user", current agent's messages = "assistant"
        msgs = []
        for entry in conversation:
            role = "assistant" if entry["speaker"] == current_idx else "user"
            msgs.append({"role": role, "content": entry["text"]})

        reply = chat_llm(current, msgs)
        print(f"  {current['name']}: {reply}")

        ipc("world-chat", {"agentId": current["id"], "text": reply[:500]})
        action = random.choice(["idle", "wave", "dance", "pinch", "talk"])
        ipc("world-action", {"agentId": current["id"], "action": action})

        conversation.append({"speaker": current_idx, "text": reply})
        time.sleep(4)

    print("\n=== Chat Complete ===")

if __name__ == "__main__":
    main()
