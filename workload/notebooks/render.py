"""Render an asmDB Fabric sync notebook from sync_template.py.

Example:
python workload\notebooks\render.py --gateway-url https://gw.example --instance-id sales --target-table lakehouse.sales_orders --key-vault-url https://vault.vault.azure.net/ --secret-name asmdb-gateway-token --output rendered_sync.py
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def render(template_text: str, replacements: dict[str, str], decoder_config: dict | None = None) -> str:
    rendered = template_text
    for key, value in replacements.items():
        rendered = rendered.replace(key, value)
    if decoder_config is not None:
        rendered = rendered.replace("DECODER_CONFIG: Dict[str, Any] = {}", f"DECODER_CONFIG: Dict[str, Any] = {json.dumps(decoder_config, sort_keys=True)}")
    return rendered


def main() -> None:
    parser = argparse.ArgumentParser(description="Render an asmDB sync notebook Python template.")
    parser.add_argument("--template", default=str(HERE / "sync_template.py"))
    parser.add_argument("--output", required=True)
    parser.add_argument("--gateway-url", required=True)
    parser.add_argument("--instance-id", required=True)
    parser.add_argument("--target-table", required=True)
    parser.add_argument("--key-vault-url", required=True)
    parser.add_argument("--secret-name", required=True)
    parser.add_argument("--decoder", default="None", choices=["None", "Hex", "Base64", "JSON", "CSV", "MessagePack"])
    parser.add_argument("--decoder-config-json", default="{}")
    parser.add_argument("--page-limit", type=int, default=5000)
    parser.add_argument("--hard-delete", action="store_true")
    args = parser.parse_args()

    decoder_config = json.loads(args.decoder_config_json)
    template = Path(args.template).read_text(encoding="utf-8")
    rendered = render(
        template,
        {
            "__ASMDB_GATEWAY_URL__": args.gateway_url,
            "__ASMDB_INSTANCE_ID__": args.instance_id,
            "__ASMDB_TARGET_TABLE__": args.target_table,
            "__ASMDB_KEY_VAULT_URL__": args.key_vault_url,
            "__ASMDB_KEY_VAULT_SECRET_NAME__": args.secret_name,
            'DECODER = "None"': f'DECODER = "{args.decoder}"',
            "PAGE_LIMIT = 5000": f"PAGE_LIMIT = {args.page_limit}",
            "HARD_DELETE = False": f"HARD_DELETE = {args.hard_delete}",
        },
        decoder_config=decoder_config,
    )
    Path(args.output).write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
