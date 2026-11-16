import type { TallyCommand } from "./types.ts";

/** Parent groups required before PW-Emp / PW-Cat ledger Create (idempotent Create). */
export function pesowiseAccountingBootstrapCommands(organizationId: string): TallyCommand[] {
  const org = organizationId;
  return [
    {
      kind: "master",
      action: "create",
      master: {
        kind: "group",
        stable_key: `${org}:master:group:pesowise_expenses`,
        display_name: "PesoWise Expenses",
        parent_group: "Direct Expenses",
      },
    },
    {
      kind: "master",
      action: "create",
      master: {
        kind: "voucher_type",
        stable_key: `${org}:master:vchtype:pesowise_expense`,
        display_name: "PesoWise Expense",
        parent_group: "Payment",
      },
    },
    {
      kind: "master",
      action: "create",
      master: {
        kind: "voucher_type",
        stable_key: `${org}:master:vchtype:pesowise_balance`,
        display_name: "PesoWise Balance",
        parent_group: "Journal",
      },
    },
  ];
}

export function jobNeedsAccountingBootstrap(commands: TallyCommand[]): boolean {
  return commands.some(
    (c) =>
      c.kind === "voucher" ||
      (c.kind === "master" &&
        c.master.kind === "ledger" &&
        c.master.parent_group === "PesoWise Expenses"),
  );
}
