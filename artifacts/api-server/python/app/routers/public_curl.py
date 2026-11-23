import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.curl_limits import CurlQuotaExceeded
from app.public_curl import fetch_for_player
from app.security import CurrentUser

router = APIRouter(prefix="/cli", tags=["cli"])


class CurlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: str = Field(min_length=1, max_length=2048)


@router.post("/curl")
async def curl(body: CurlRequest, user: CurrentUser):
    try:
        output = await asyncio.wait_for(fetch_for_player(body.url, user.id), timeout=12)
        return {"output": output}
    except CurlQuotaExceeded as exc:
        raise HTTPException(
            429,
            "curl: too many requests; try again shortly",
            headers={"Retry-After": str(exc.retry_after)},
        ) from exc
    except ValueError as exc:
        # Only controlled validation messages; never return URLs or socket errors.
        raise HTTPException(400, "curl: request blocked or invalid") from exc
    except Exception as exc:
        raise HTTPException(502, "curl: request failed or timed out") from exc
