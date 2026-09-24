import pytest

from ai_router.limiter.memory import MemoryStore


@pytest.mark.asyncio
async def test_memory_store_take_and_limit():
    store = MemoryStore()

    # 1st request with cost 1, limit 2
    res1 = await store.take("rl:route-1:rpm", cost=1, windowMs=60000, limit=2)
    assert res1.allowed is True
    assert res1.retryAfterMs == 0

    # 2nd request with cost 1, limit 2
    res2 = await store.take("rl:route-1:rpm", cost=1, windowMs=60000, limit=2)
    assert res2.allowed is True

    # 3rd request should exceed limit (2 + 1 > 2)
    res3 = await store.take("rl:route-1:rpm", cost=1, windowMs=60000, limit=2)
    assert res3.allowed is False
    assert res3.retryAfterMs > 0


@pytest.mark.asyncio
async def test_memory_store_record_and_used():
    store = MemoryStore()

    await store.record("rl:route-1:tpm", cost=300, windowMs=60000)
    await store.record("rl:route-1:tpm", cost=250, windowMs=60000)

    used = store.used("rl:route-1:tpm", windowMs=60000)
    assert used == 550.0

    snap = store.snapshot()
    assert "rl:route-1:tpm" in snap
    assert snap["rl:route-1:tpm"] == 550.0
