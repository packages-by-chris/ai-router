"""Tests for configuration validation, parsing, and environment variable interpolation."""

import pytest

from ai_router import ConfigError, parse_config


def test_parse_minimal_valid_config() -> None:
    raw = {
        "routes": [
            {
                "id": "fast",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "apiKey": "sk-123",
            }
        ]
    }
    cfg = parse_config(raw)
    assert len(cfg.routes) == 1
    assert cfg.routes[0].id == "fast"
    assert cfg.routes[0].provider == "openai"
    assert cfg.routes[0].model == "gpt-4o-mini"
    assert cfg.routes[0].apiKey == "sk-123"


def test_env_interpolation() -> None:
    raw = {
        "routes": [
            {
                "id": "fast",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "apiKey": "${TEST_API_KEY}",
            }
        ]
    }
    cfg = parse_config(raw, env={"TEST_API_KEY": "secret_abc_123"})
    assert cfg.routes[0].apiKey == "secret_abc_123"


def test_missing_env_raises_config_error() -> None:
    raw = {
        "routes": [
            {
                "id": "fast",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "apiKey": "${UNSET_VAR}",
            }
        ]
    }
    with pytest.raises(ConfigError) as exc_info:
        parse_config(raw, env={})
    assert 'environment variable "UNSET_VAR" is not set' in str(exc_info.value)


def test_invalid_top_level_fields() -> None:
    raw = {
        "routes": [
            {
                "id": "fast",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "apiKey": "sk-123",
            }
        ],
        "unknownField": 123,
    }
    with pytest.raises(ConfigError) as exc_info:
        parse_config(raw)
    assert "config.unknownField: unknown field" in str(exc_info.value)


def test_duplicate_route_id() -> None:
    raw = {
        "routes": [
            {"id": "route1", "provider": "openai", "model": "gpt-4o", "apiKey": "k1"},
            {"id": "route1", "provider": "anthropic", "model": "claude-3-5", "apiKey": "k2"},
        ]
    }
    with pytest.raises(ConfigError) as exc_info:
        parse_config(raw)
    assert 'duplicate route id "route1"' in str(exc_info.value)


def test_azure_provider_requires_base_url_and_api_version() -> None:
    raw = {
        "routes": [
            {
                "id": "azure-route",
                "provider": "azure",
                "model": "gpt-4o",
                "apiKey": "k1",
            }
        ]
    }
    with pytest.raises(ConfigError) as exc_info:
        parse_config(raw)
    err = str(exc_info.value)
    assert 'config.routes[0].baseUrl: required when provider is "azure"' in err
    assert 'config.routes[0].apiVersion: required when provider is "azure"' in err


def test_presets_no_auth_allowed() -> None:
    raw = {
        "routes": [
            {
                "id": "local-ollama",
                "provider": "ollama",
                "model": "llama3",
            }
        ]
    }
    cfg = parse_config(raw)
    assert cfg.routes[0].provider == "ollama"
