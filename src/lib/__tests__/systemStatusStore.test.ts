/**
 * Tests for the pure applyWrite function and InMemorySystemStatusStore.
 * Tests 27–40.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { applyWrite, InMemorySystemStatusStore } from "../../../api/_lib/systemStatusStore";
import { defaultStatusDocument } from "../../../api/_lib/systemStatusTypes";
import type { SystemStatusDocument } from "../../../api/_lib/systemStatusTypes";

const NOW = new Date("2026-07-16T12:00:00Z");

function freshDoc(): SystemStatusDocument {
  return { ...defaultStatusDocument(), revision: "rev-0" };
}

describe("applyWrite — start_manual", () => {
  it("T27: creates manual maintenance with correct fields", () => {
    const result = applyWrite(
      freshDoc(),
      {
        action: "start_manual",
        revision: "rev-0",
        title: "Emergency Down",
        message: "We are investigating.",
        estimated_end_at: "2026-07-16T14:00:00Z",
      },
      NOW,
    );
    expect("error" in result).toBe(false);
    if ("doc" in result) {
      expect(result.doc.manual_maintenance?.enabled).toBe(true);
      expect(result.doc.manual_maintenance?.title).toBe("Emergency Down");
      expect(result.doc.revision).not.toBe("rev-0");
    }
  });

  it("T28: rejects start_manual when maintenance already active", () => {
    const doc: SystemStatusDocument = {
      ...freshDoc(),
      manual_maintenance: {
        enabled: true,
        incident_id: "inc-1",
        title: "Already running",
        message: "...",
        started_at: NOW.toISOString(),
        estimated_end_at: null,
      },
    };
    const result = applyWrite(
      doc,
      { action: "start_manual", revision: "rev-0", title: "New", message: "New", estimated_end_at: null },
      NOW,
    );
    expect("error" in result).toBe(true);
  });

  it("T29: rejects with conflict when revision is stale", () => {
    const result = applyWrite(
      freshDoc(),
      { action: "start_manual", revision: "wrong-rev", title: "X", message: "Y", estimated_end_at: null },
      NOW,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.conflict).toBe(true);
    }
  });
});

describe("applyWrite — end_manual", () => {
  it("T30: clears manual_maintenance on end_manual", () => {
    const doc: SystemStatusDocument = {
      ...freshDoc(),
      manual_maintenance: {
        enabled: true,
        incident_id: "inc-1",
        title: "Active",
        message: "Running",
        started_at: "2026-07-16T10:00:00Z",
        estimated_end_at: null,
      },
    };
    const result = applyWrite(doc, { action: "end_manual", revision: "rev-0" }, NOW);
    expect("doc" in result).toBe(true);
    if ("doc" in result) {
      expect(result.doc.manual_maintenance).toBeNull();
    }
  });

  it("T31: rejects end_manual when no active maintenance", () => {
    const result = applyWrite(freshDoc(), { action: "end_manual", revision: "rev-0" }, NOW);
    expect("error" in result).toBe(true);
  });
});

describe("applyWrite — create_window", () => {
  it("T32: creates a new scheduled window", () => {
    const result = applyWrite(
      freshDoc(),
      {
        action: "create_window",
        revision: "rev-0",
        title: "Planned Maintenance",
        message: "Brief downtime.",
        starts_at: "2026-07-20T10:00:00Z",
        ends_at: "2026-07-20T12:00:00Z",
        announce_from: "2026-07-20T08:00:00Z",
      },
      NOW,
    );
    expect("doc" in result).toBe(true);
    if ("doc" in result) {
      expect(result.doc.windows.length).toBe(1);
      expect(result.doc.windows[0].status).toBe("scheduled");
      expect(result.doc.windows[0].title).toBe("Planned Maintenance");
    }
  });
});

describe("applyWrite — cancel_window", () => {
  it("T33: cancels an existing window by id", () => {
    const doc: SystemStatusDocument = {
      ...freshDoc(),
      windows: [
        {
          id: "win-1",
          title: "My Window",
          message: "text",
          starts_at: "2026-07-20T10:00:00Z",
          ends_at: "2026-07-20T12:00:00Z",
          announce_from: "2026-07-20T08:00:00Z",
          status: "scheduled",
          created_at: NOW.toISOString(),
          updated_at: NOW.toISOString(),
        },
      ],
    };
    const result = applyWrite(doc, { action: "cancel_window", revision: "rev-0", window_id: "win-1" }, NOW);
    expect("doc" in result).toBe(true);
    if ("doc" in result) {
      const w = result.doc.windows.find((w) => w.id === "win-1");
      expect(w?.status).toBe("cancelled");
    }
  });

  it("T34: returns error when window_id not found", () => {
    const result = applyWrite(
      freshDoc(),
      { action: "cancel_window", revision: "rev-0", window_id: "ghost" },
      NOW,
    );
    expect("error" in result).toBe(true);
  });
});

describe("InMemorySystemStatusStore", () => {
  let store: InMemorySystemStatusStore;

  beforeEach(() => {
    store = new InMemorySystemStatusStore(freshDoc());
  });

  it("T35: read returns the default document", async () => {
    const result = await store.read();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc.schema_version).toBe(1);
    }
  });

  it("T36: write applies change and updates internal doc", async () => {
    const readBefore = await store.read();
    if (!readBefore.ok) throw new Error("read failed");
    const writeResult = await store.write(
      {
        action: "start_manual",
        revision: readBefore.doc.revision,
        title: "Down",
        message: "In progress.",
        estimated_end_at: null,
      },
      NOW,
    );
    expect(writeResult.ok).toBe(true);
    if (writeResult.ok) {
      expect(writeResult.doc.manual_maintenance?.enabled).toBe(true);
    }

    const readAfter = await store.read();
    if (!readAfter.ok) throw new Error("read failed");
    expect(readAfter.doc.manual_maintenance?.enabled).toBe(true);
  });

  it("T37: write returns conflict error on stale revision", async () => {
    const result = await store.write(
      { action: "end_manual", revision: "stale-rev" },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
    }
  });

  it("T38: read returns a structural clone (mutations don't affect store)", async () => {
    const r1 = await store.read();
    if (!r1.ok) throw new Error();
    r1.doc.revision = "mutated";
    const r2 = await store.read();
    if (!r2.ok) throw new Error();
    expect(r2.doc.revision).toBe("rev-0");
  });

  it("T39: sequential writes use updated revision", async () => {
    const r1 = await store.read();
    if (!r1.ok) throw new Error();

    const w1 = await store.write(
      {
        action: "start_manual",
        revision: r1.doc.revision,
        title: "Down",
        message: ".",
        estimated_end_at: null,
      },
      NOW,
    );
    expect(w1.ok).toBe(true);
    if (!w1.ok) throw new Error();

    const w2 = await store.write(
      { action: "end_manual", revision: w1.doc.revision },
      NOW,
    );
    expect(w2.ok).toBe(true);
    if (!w2.ok) throw new Error();
    expect(w2.doc.manual_maintenance).toBeNull();
  });

  it("T40: write fails with correct error when trying to end non-existent maintenance", async () => {
    const r = await store.read();
    if (!r.ok) throw new Error();
    const result = await store.write({ action: "end_manual", revision: r.doc.revision }, NOW);
    expect(result.ok).toBe(false);
  });
});

describe("applyWrite — publish_announcement", () => {
  it("T41: publishes announcement with correct fields", () => {
    const result = applyWrite(
      freshDoc(),
      { action: "publish_announcement", revision: "rev-0", title: "Delay tonight", message: "Reports delayed by 2h." },
      NOW,
    );
    expect("doc" in result).toBe(true);
    if ("doc" in result) {
      expect(result.doc.announcement).not.toBeNull();
      expect(result.doc.announcement?.title).toBe("Delay tonight");
      expect(result.doc.announcement?.message).toBe("Reports delayed by 2h.");
      expect(result.doc.announcement?.published_at).toBe(NOW.toISOString());
    }
  });

  it("T42: overwrites existing announcement", () => {
    const docWithAnn = {
      ...freshDoc(),
      announcement: { id: "old-id", title: "Old", message: "Old msg", published_at: NOW.toISOString(), updated_at: NOW.toISOString() },
    };
    const result = applyWrite(
      docWithAnn,
      { action: "publish_announcement", revision: "rev-0", title: "New", message: "New msg" },
      NOW,
    );
    expect("doc" in result).toBe(true);
    if ("doc" in result) {
      expect(result.doc.announcement?.title).toBe("New");
      expect(result.doc.announcement?.id).not.toBe("old-id");
    }
  });

  it("T43: requires correct revision", () => {
    const result = applyWrite(
      freshDoc(),
      { action: "publish_announcement", revision: "wrong-rev", title: "X", message: "Y" },
      NOW,
    );
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.conflict).toBe(true);
  });
});

describe("applyWrite — clear_announcement", () => {
  it("T44: clears an existing announcement", () => {
    const docWithAnn = {
      ...freshDoc(),
      announcement: { id: "ann-1", title: "Hello", message: "World", published_at: NOW.toISOString(), updated_at: NOW.toISOString() },
    };
    const result = applyWrite(docWithAnn, { action: "clear_announcement", revision: "rev-0" }, NOW);
    expect("doc" in result).toBe(true);
    if ("doc" in result) {
      expect(result.doc.announcement).toBeNull();
    }
  });

  it("T45: clear on doc without announcement still succeeds", () => {
    const result = applyWrite(freshDoc(), { action: "clear_announcement", revision: "rev-0" }, NOW);
    expect("doc" in result).toBe(true);
    if ("doc" in result) expect(result.doc.announcement).toBeNull();
  });
});
