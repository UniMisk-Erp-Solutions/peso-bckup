import { describe, expect, it } from "vitest";
import {
  detectBulkUsersCsvMode,
  parseBulkUsersCsv,
  resolveManagerUserId,
  resolveSupervisorUserId,
} from "@/lib/bulkUsersCsv";

describe("bulkUsersCsv", () => {
  it("parses csv and maps position aliases", () => {
    const csv = [
      "name,email,position,password",
      "John,john@example.com,manager,Pass@123",
      "Alice,alice@example.com,employee,Pass@123",
    ].join("\n");
    const parsed = parseBulkUsersCsv(csv);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].role).toBe("engineer");
    expect(parsed.rows[1].role).toBe("employee");
  });

  it("parses employee-id mode without email", () => {
    const csv = [
      "name,employee_id,position,password,immediate_supervisor_employee_id",
      "John,MGR001,manager,Pass@123,",
      "Alice,EMP001,employee,Pass@123,MGR001",
    ].join("\n");
    const parsed = parseBulkUsersCsv(csv, { employeeIdLoginMode: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0].employee_id).toBe("mgr001");
    expect(parsed.rows[0].email).toBeUndefined();
    expect(parsed.rows[1].immediate_supervisor_employee_id).toBe("mgr001");
  });

  it("detects employee-id csv mode from headers", () => {
    const csv = "name,employee_id,position,password\nA,1,employee,x";
    expect(detectBulkUsersCsvMode(csv)).toBe("employee_id");
    expect(detectBulkUsersCsvMode("name,email,position,password\nA,a@b.com,employee,x")).toBe(
      "email",
    );
  });

  it("accepts employees plural in position column", () => {
    const csv = [
      "name,employee_id,position,password,immediate_supervisor_employee_id,location",
      "Vishal Vyas,5002,employees,vis.123,5022,Ahmedabad",
    ].join("\n");
    const parsed = parseBulkUsersCsv(csv, { employeeIdLoginMode: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].role).toBe("employee");
    expect(parsed.rows[0].employee_id).toBe("5002");
  });

  it("requires employee_id in employee-id mode", () => {
    const csv = ["name,position,password", "Alice,employee,Pass@123"].join("\n");
    const parsed = parseBulkUsersCsv(csv, { employeeIdLoginMode: true });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]).toMatch(/employee_id/);
  });

  it("parses team_name column", () => {
    const csv = [
      "name,employee_id,position,password,team_name",
      "Alice,EMP001,employee,Pass@123,Reliance C&I",
    ].join("\n");
    const parsed = parseBulkUsersCsv(csv, { employeeIdLoginMode: true });
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0].team_name).toBe("Reliance C&I");
  });

  it("resolves manager by email only", () => {
    const importedByEmail = new Map([["mgr@org.com", "u1"]]);
    const existingByEmail = new Map([["oldmgr@org.com", "u2"]]);

    expect(resolveManagerUserId("mgr@org.com", importedByEmail, existingByEmail)).toBe("u1");
    expect(resolveManagerUserId("oldmgr@org.com", importedByEmail, existingByEmail)).toBe("u2");
    expect(resolveManagerUserId("missing@org.com", importedByEmail, existingByEmail)).toBeUndefined();
  });

  it("resolves supervisor by employee id", () => {
    const importedByEmployeeId = new Map([["mgr001", "u1"]]);
    const existingByEmployeeId = new Map([["tl002", "u2"]]);
    expect(
      resolveSupervisorUserId({
        supervisorEmployeeId: "mgr001",
        importedByEmail: new Map(),
        existingByEmail: new Map(),
        importedByEmployeeId,
        existingByEmployeeId,
      }),
    ).toBe("u1");
    expect(
      resolveSupervisorUserId({
        supervisorEmployeeId: "tl002",
        importedByEmail: new Map(),
        existingByEmail: new Map(),
        importedByEmployeeId: new Map(),
        existingByEmployeeId,
      }),
    ).toBe("u2");
  });
});
