"""ASGI entrypoint: `uvicorn app.asgi:app`.

Kept separate so importing ``app.main`` has no side effects (tests build their own app).
"""

from app.main import create_app

app = create_app()
