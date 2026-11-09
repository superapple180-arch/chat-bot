import asyncio
import json
import sys

import edge_tts


async def main():
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    await edge_tts.Communicate(request["text"], request["voice"]).save(request["output"])


if __name__ == "__main__":
    asyncio.run(main())
