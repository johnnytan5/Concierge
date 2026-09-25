"""Writes dashboard/lib/voice/agent-config.json from the Python orchestrator,
so the web demo's voice agent uses the exact same prompt, tools, hotel facts
and turn-taking settings as the local one. Re-run after changing any of them:

    .venv/bin/python scripts/export_agent_config.py
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
os.environ.setdefault("OPENROUTER_API_KEY", "unused")  # agent_definition() reads it; never exported

from orchestrator import agent, tools  # noqa: E402
from orchestrator.hotel_facts import HOTEL_FACTS  # noqa: E402

d = agent.agent_definition("unused", room="0000")
config = {
    "base_prompt": agent._BASE_PROMPT,
    "llm_base_url": agent.LLM_BASE_URL,
    "llm_model": agent.LLM_MODEL,
    "voice": d["voice"],
    "input": {k: v for k, v in d["input"].items() if k != "keyterms"},
    "keyterms": agent.KEYTERMS,
    "tools": tools.SESSION_TOOLS,
    "hotel_facts": HOTEL_FACTS,
    "max_nudges": agent.MAX_NUDGES,
    "sample_rate": agent.SAMPLE_RATE,
}
out = os.path.join(ROOT, "dashboard", "lib", "voice", "agent-config.json")
with open(out, "w") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"wrote {out}")
