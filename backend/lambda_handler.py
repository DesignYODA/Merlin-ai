"""
lambda_handler.py — AWS Lambda entry point.

Wraps the existing FastAPI app (main:app) with Mangum so it can run behind
API Gateway (REST or HTTP API) or a Lambda Function URL, unchanged from its
local uvicorn deployment.Is there a disposition for the responses?

Handler path for the Lambda console / IaC config: lambda_handler.handler

Note: /final-response streams via SSE (StreamingResponse). API Gateway + Mangum
buffers the full response before returning it, so token-by-token streaming to
the client does not work in this deployment mode — the caller still receives
the complete response, just not incrementally. True streaming requires a
Lambda Function URL with response streaming (RESPONSE_STREAM invoke mode),
which needs a different adapter than Mangum's default ASGI handling.
"""

from mangum import Mangum

from main import app

handler = Mangum(app, lifespan="auto")
