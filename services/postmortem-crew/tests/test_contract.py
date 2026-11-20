"""The Python side of the TS <-> Python contract (packages/schemas)."""

import json
from pathlib import Path

import jsonschema

SCHEMAS = Path(__file__).resolve().parents[3] / "packages" / "schemas"


def _load(relative: str) -> dict:
    return json.loads((SCHEMAS / relative).read_text())


def test_valid_incident_fixture_matches_generated_json_schema() -> None:
    schema = _load("json/incident-state.schema.json")
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate(_load("fixtures/incident-state.valid.json"), schema)


def test_incident_without_required_fields_is_rejected() -> None:
    schema = _load("json/incident-state.schema.json")
    validator = jsonschema.Draft202012Validator(schema)
    assert not validator.is_valid({"incidentId": "inc-1"})
