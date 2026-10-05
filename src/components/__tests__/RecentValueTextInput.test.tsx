import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RecentValueTextInput } from "@/components/RecentValueTextInput";

describe("RecentValueTextInput", () => {
  it("always allows free typing regardless of recent values", () => {
    const onChange = vi.fn();
    render(<RecentValueTextInput value="" onChange={onChange} recentValues={["Ahmedabad"]} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Something brand new" } });
    expect(onChange).toHaveBeenCalledWith("Something brand new");
  });

  it("renders with no visible suggestion chrome when recentValues is empty (feature off / no data), and stays a plain textbox -- never role=combobox with a popup that can never appear", () => {
    render(<RecentValueTextInput value="" onChange={vi.fn()} recentValues={[]} />);
    const input = screen.getByRole("textbox");
    fireEvent.focus(input);
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("role", "combobox");
  });

  it("shows a Recent list on focus when values exist, and selecting one calls onChange with that exact value", () => {
    const onChange = vi.fn();
    render(
      <RecentValueTextInput value="" onChange={onChange} recentValues={["Ahmedabad Office", "Surat Plant"]} />,
    );
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getByText("Ahmedabad Office")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByText("Ahmedabad Office"));
    expect(onChange).toHaveBeenCalledWith("Ahmedabad Office");
  });

  it("filters the suggestion list as the user types", () => {
    render(
      <RecentValueTextInput
        value="san"
        onChange={vi.fn()}
        recentValues={["Sanand GIDC", "Sanand Plant", "Ahmedabad Office"]}
      />,
    );
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getByText("Sanand GIDC")).toBeInTheDocument();
    expect(screen.getByText("Sanand Plant")).toBeInTheDocument();
    expect(screen.queryByText("Ahmedabad Office")).not.toBeInTheDocument();
  });

  it("renders a textarea when multiline is set", () => {
    render(<RecentValueTextInput value="" onChange={vi.fn()} multiline rows={3} />);
    expect(screen.getByRole("textbox").tagName).toBe("TEXTAREA");
  });

  describe("browser-native autofill suppression (owner QA fix pass)", () => {
    it("sets autoComplete=off", () => {
      render(<RecentValueTextInput value="" onChange={vi.fn()} recentValues={["A"]} />);
      expect(screen.getByRole("combobox")).toHaveAttribute("autocomplete", "off");
    });

    it("uses a generated `name` that does not contain address/location-pattern words a browser's own heuristic autofill keys off, independent of `id`", () => {
      render(<RecentValueTextInput id="destination" value="" onChange={vi.fn()} recentValues={["A"]} />);
      const input = screen.getByRole("combobox");
      const name = input.getAttribute("name") ?? "";
      expect(name).toMatch(/^pw-recent-/);
      expect(name.toLowerCase()).not.toContain("destination");
      expect(name.toLowerCase()).not.toContain("address");
      expect(name.toLowerCase()).not.toContain("location");
      // id is untouched -- label association/accessibility still works.
      expect(input).toHaveAttribute("id", "destination");
    });

    it("suppression (autoComplete/name) applies even with zero recentValues -- avoids native autofill before this field's own memory data has ever loaded", () => {
      render(<RecentValueTextInput value="" onChange={vi.fn()} recentValues={[]} />);
      const input = screen.getByRole("textbox");
      expect(input).toHaveAttribute("autocomplete", "off");
      expect(input.getAttribute("name")).toMatch(/^pw-recent-/);
    });
  });

  describe("ARIA combobox pattern (owner QA fix pass)", () => {
    it("exposes role=combobox with aria-expanded/aria-controls/aria-autocomplete", () => {
      render(<RecentValueTextInput value="" onChange={vi.fn()} recentValues={["Ahmedabad Office"]} />);
      const input = screen.getByRole("combobox");
      expect(input).toHaveAttribute("aria-autocomplete", "list");
      expect(input).toHaveAttribute("aria-expanded", "false");
      fireEvent.focus(input);
      expect(input).toHaveAttribute("aria-expanded", "true");
      expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
    });

    it("renders suggestions as role=listbox/option, not a bare div/button list", () => {
      render(
        <RecentValueTextInput value="" onChange={vi.fn()} recentValues={["Ahmedabad Office", "Surat Plant"]} />,
      );
      fireEvent.focus(screen.getByRole("combobox"));
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      expect(screen.getAllByRole("option")).toHaveLength(2);
    });

    it("ArrowDown/ArrowUp move aria-activedescendant across options, wrapping at the ends", () => {
      render(
        <RecentValueTextInput
          value=""
          onChange={vi.fn()}
          recentValues={["Ahmedabad Office", "Surat Plant", "Vadodara Depot"]}
        />,
      );
      const input = screen.getByRole("combobox");
      fireEvent.focus(input);
      const options = screen.getAllByRole("option");

      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);

      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
      // Wraps from the first option to the last on ArrowUp.
      fireEvent.keyDown(input, { key: "ArrowUp" });
      expect(input.getAttribute("aria-activedescendant")).toBe(options[2].id);
    });

    it("Enter selects the highlighted option", () => {
      const onChange = vi.fn();
      render(
        <RecentValueTextInput value="" onChange={onChange} recentValues={["Ahmedabad Office", "Surat Plant"]} />,
      );
      const input = screen.getByRole("combobox");
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith("Surat Plant");
    });

    it("Enter does nothing when no option is highlighted -- never silently selects the first one", () => {
      const onChange = vi.fn();
      render(<RecentValueTextInput value="typed text" onChange={onChange} recentValues={["Ahmedabad Office"]} />);
      const input = screen.getByRole("combobox");
      fireEvent.focus(input);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onChange).not.toHaveBeenCalledWith("Ahmedabad Office");
    });

    it("Escape closes the suggestion list", () => {
      render(<RecentValueTextInput value="" onChange={vi.fn()} recentValues={["Ahmedabad Office"]} />);
      const input = screen.getByRole("combobox");
      fireEvent.focus(input);
      expect(screen.getByRole("listbox")).toBeInTheDocument();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });
});
