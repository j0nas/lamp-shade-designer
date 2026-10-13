// Collapse/expand a floating control panel down to just its header — for small viewports where
// the panel overlay would otherwise cover the model. Headless like renderPanel: this wires a
// toggle button (class `panel-collapse`, aria-expanded) into the header and flips a `collapsed`
// class on the panel; the app's CSS decides what collapsed looks like, typically
//   #panel.collapsed > :not(h1) { display: none }
//   #panel.collapsed { width: auto }
// State is deliberately NOT persisted: it is per-visit view chrome, and a phone and a desktop
// visiting the same app want different defaults (pass matchMedia into startCollapsed instead).

export type PanelCollapse = {
  collapsed: boolean;
  set(collapsed: boolean): void;
};

export function installPanelCollapse(
  panel: HTMLElement,
  header: HTMLElement,
  opts: { startCollapsed?: boolean } = {},
): PanelCollapse {
  const doc = panel.ownerDocument;
  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = "panel-collapse";
  header.append(btn);

  const api: PanelCollapse = {
    collapsed: false,
    set(collapsed: boolean): void {
      api.collapsed = collapsed;
      panel.classList.toggle("collapsed", collapsed);
      btn.textContent = collapsed ? "▸" : "▾";
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.setAttribute("aria-label", collapsed ? "Show controls" : "Hide controls");
    },
  };
  btn.addEventListener("click", () => api.set(!api.collapsed));
  api.set(opts.startCollapsed ?? false);
  return api;
}
