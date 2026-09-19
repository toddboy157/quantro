# Single-container deploy: the Starlette/uvicorn backend serves both the
# API and the static frontend (see backend/app/server.py's FRONTEND_ROOT -
# it resolves the frontend directory relative to this file's location, so
# the backend/ and frontend/ folders must sit side by side exactly like
# this repo already lays them out).
FROM python:3.11-slim

WORKDIR /srv/quantro

# Install deps first so Docker's layer cache skips this step on code-only
# changes.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend

WORKDIR /srv/quantro/backend

# Railway/Render/Fly all inject PORT at runtime; config.py already reads it
# via os.getenv("PORT", "8000"), so nothing else to wire up here. HOST must
# be 0.0.0.0 (not 127.0.0.1) so the platform's proxy can reach it.
ENV HOST=0.0.0.0

# Real config (POLYGON_API_KEY, SECRET_KEY, DB_PATH, etc.) is supplied as
# platform environment variables at deploy time, NOT baked into the image -
# see DEPLOY.md. There is intentionally no `COPY backend/.env` here.

EXPOSE 8000

CMD ["python3", "run.py"]
