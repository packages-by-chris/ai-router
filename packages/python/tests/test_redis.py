"""Unit tests for Python RedisRateLimitStore and RedisRouterStateStore."""

import pytest

from ai_router.limiter.redis import (
    RECORD_SCRIPT,
    TAKE_SCRIPT,
    USED_SCRIPT,
    RedisRateLimitStore,
    RedisRouterStateStore,
)


class MockRedisClient:
    """In-memory mock for redis-py eval and get/set."""

    def __init__(self):
        self.kv = {}
        # key -> list of (score, member)
        self.zsets = {}

    async def get(self, key: str):
        return self.kv.get(key)

    async def set(self, key: str, value: str, ex: int | None = None):
        self.kv[key] = value

    async def eval(self, script: str, numkeys: int, *keys_and_args):
        key = keys_and_args[0]
        args = keys_and_args[1:]

        if script == TAKE_SCRIPT:
            cost = int(args[0])
            window_ms = int(args[1])
            limit = int(args[2])
            now = int(args[3])
            member = str(args[4])

            zset = self.zsets.setdefault(key, [])
            cutoff = now - window_ms
            # ZREMRANGEBYSCORE
            self.zsets[key] = [(s, m) for (s, m) in zset if s > cutoff]

            used = sum(int(m.split(":")[-1]) for (s, m) in self.zsets[key])
            if used + cost <= limit:
                self.zsets[key].append((now, member))
                return [1, 0]
            return [0, 1000]

        elif script == RECORD_SCRIPT:
            cost = int(args[0])
            window_ms = int(args[1])
            now = int(args[2])
            member = str(args[3])

            zset = self.zsets.setdefault(key, [])
            cutoff = now - window_ms
            self.zsets[key] = [(s, m) for (s, m) in zset if s > cutoff]
            self.zsets[key].append((now, member))
            return 1

        elif script == USED_SCRIPT:
            window_ms = int(args[0])
            now = int(args[1])
            zset = self.zsets.get(key, [])
            cutoff = now - window_ms
            valid = [(s, m) for (s, m) in zset if s > cutoff]
            return sum(int(m.split(":")[-1]) for (s, m) in valid)

        raise NotImplementedError("Unknown script")


@pytest.mark.asyncio
async def test_redis_rate_limit_store():
    client = MockRedisClient()
    store = RedisRateLimitStore(client, prefix="test:rl:", now_fn=lambda: 1000)

    # 1. Take within limit
    d1 = await store.take("user_1", 5, 60000, 10)
    assert d1.allowed is True
    assert d1.retryAfterMs == 0

    # 2. Check used
    used = store.used("user_1", 60000)
    assert used == 5

    # 3. Take exceeding limit
    d2 = await store.take("user_1", 6, 60000, 10)
    assert d2.allowed is False
    assert d2.retryAfterMs > 0

    # 4. Record post-hoc
    await store.record("user_1", 2, 60000)
    used_after = store.used("user_1", 60000)
    assert used_after == 7


@pytest.mark.asyncio
async def test_redis_router_state_store():
    client = MockRedisClient()
    state_store = RedisRouterStateStore(client, key="test:state")

    # Initial get is None
    assert await state_store.get() is None

    # Set state
    await state_store.set({"health": {"r1": {"succ": 10}}})

    # Get state back
    loaded = await state_store.get()
    assert loaded == {"health": {"r1": {"succ": 10}}}
