"""Redis-backed RateLimitStore and RouterStateStore for ai-router.

Sliding-window log per key, stored as a ZSET with atomic Lua scripts.
No hard dependency on any specific Redis library (compatible with redis-py asyncio or custom clients).
"""

from __future__ import annotations

import json
import random
import time
from collections.abc import Sequence
from typing import Any, Protocol

from .store import RateLimitDecision, RateLimitStore

TAKE_SCRIPT = """
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local member = ARGV[5]
local cutoff = now - window_ms
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local entries = redis.call('ZRANGE', key, 0, -1)
local used = 0
for i = 1, #entries do
  local c = tonumber(string.match(entries[i], ':(%d+)$'))
  if c then used = used + c end
end
if used + cost <= limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window_ms)
  return {1, 0}
end
local retry = 1
if #entries > 0 then
  local oldest = string.match(entries[1], '^(%d+):')
  if oldest then retry = math.max(1, tonumber(oldest) + window_ms - now) end
end
return {0, retry}
"""

RECORD_SCRIPT = """
local key = KEYS[1]
local cost = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms)
return 1
"""

USED_SCRIPT = """
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)
local entries = redis.call('ZRANGE', key, 0, -1)
local used = 0
for i = 1, #entries do
  local c = tonumber(string.match(entries[i], ':(%d+)$'))
  if c then used = used + c end
end
return used
"""


class RedisEvalClient(Protocol):
    """Minimal async client protocol for Redis EVAL."""

    async def eval(self, script: str, numkeys: int, *keys_and_args: Any) -> Any: ...


class RedisRateLimitStore(RateLimitStore):
    """Redis-backed rate limit store using atomic Lua sliding-window logs."""

    def __init__(
        self,
        client: Any,
        prefix: str = "airouter:rl:",
        now_fn: Any = None,
    ) -> None:
        self.client = client
        self.prefix = prefix
        self.now_fn = now_fn or (lambda: int(time.time() * 1000))
        self._seq = 0
        self._cached_used: dict[str, float] = {}

    def _format_key(self, key: str) -> str:
        return f"{self.prefix}{key}"

    def _unique_member(self, now: int, cost: int) -> str:
        self._seq = (self._seq + 1) % 1000000
        rand = random.randint(0, 999999)
        return f"{now}:{self._seq}:{rand}:{cost}"

    async def _eval(self, script: str, keys: Sequence[str], args: Sequence[Any]) -> Any:
        if hasattr(self.client, "eval"):
            return await self.client.eval(script, len(keys), *keys, *args)
        raise RuntimeError("Redis client does not support eval()")

    async def take(self, key: str, cost: int, windowMs: int, limit: int) -> RateLimitDecision:
        now = self.now_fn()
        member = self._unique_member(now, cost)
        redis_key = self._format_key(key)

        res = await self._eval(TAKE_SCRIPT, [redis_key], [cost, windowMs, limit, now, member])
        allowed = bool(res[0] == 1)
        retry_after = int(res[1]) if len(res) > 1 else (0 if allowed else 1)
        if allowed:
            self._cached_used[key] = self._cached_used.get(key, 0.0) + cost
        return RateLimitDecision(allowed=allowed, retryAfterMs=retry_after)

    async def record(self, key: str, cost: int, windowMs: int) -> None:
        now = self.now_fn()
        member = self._unique_member(now, cost)
        redis_key = self._format_key(key)
        await self._eval(RECORD_SCRIPT, [redis_key], [cost, windowMs, now, member])
        self._cached_used[key] = self._cached_used.get(key, 0.0) + cost

    def used(self, key: str, windowMs: int) -> float:
        return self._cached_used.get(key, 0.0)

    async def used_async(self, key: str, windowMs: int) -> int:
        now = self.now_fn()
        redis_key = self._format_key(key)
        res = await self._eval(USED_SCRIPT, [redis_key], [windowMs, now])
        return int(res) if res is not None else 0

    def snapshot(self) -> dict[str, float]:
        return dict(self._cached_used)


class RedisRouterStateStore:
    """Redis-backed persistent router state store for multi-replica sync."""

    def __init__(
        self,
        client: Any,
        key: str = "airouter:state:default",
        ttl_sec: int = 86400 * 7,
    ) -> None:
        self.client = client
        self.key = key
        self.ttl_sec = ttl_sec

    async def get(self) -> dict[str, Any] | None:
        if hasattr(self.client, "get"):
            val = await self.client.get(self.key)
            if val is None:
                return None
            if isinstance(val, bytes):
                val = val.decode("utf-8")
            return json.loads(val) if isinstance(val, str) else None
        return None

    async def set(self, data: dict[str, Any]) -> None:
        val = json.dumps(data)
        if hasattr(self.client, "set"):
            await self.client.set(self.key, val, ex=self.ttl_sec)
