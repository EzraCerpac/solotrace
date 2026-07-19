from __future__ import annotations

import uvicorn


def run() -> None:
    uvicorn.run(
        "solotrace.api:app",
        host="127.0.0.1",
        port=8765,
        app_dir="server",
        reload=False,
    )


if __name__ == "__main__":
    run()
