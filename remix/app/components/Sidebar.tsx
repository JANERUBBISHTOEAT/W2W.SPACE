import * as Tooltip from "@radix-ui/react-tooltip";
import { Form, Link, NavLink, useLocation, useSubmit } from "react-router";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactElement } from "react";
import { fileIconMap } from "~/utils/constants";
import type { LocalFile } from "~/utils/files.local";
import type { LocalText } from "~/utils/texts.local";

export type SidebarItem = { kind: "file"; record: LocalFile } | { kind: "text"; record: LocalText };
type Preferences = { width: number; collapsed: boolean };
const STORAGE_KEY = "w2w.sidebar.v1";
const DEFAULT_WIDTH = 288;
const MIN_WIDTH = 200;
const RAIL_WIDTH = 64;
const MOBILE_QUERY = "(max-width: 767px), (max-width: 1023px) and (max-height: 500px) and (pointer: coarse)";

function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (value && typeof value.width === "number" && Number.isFinite(value.width) && typeof value.collapsed === "boolean") {
      return { width: Math.min(480, Math.max(MIN_WIDTH, value.width)), collapsed: value.collapsed };
    }
  } catch { /* A blocked preference store must not disable navigation. */ }
  return { width: DEFAULT_WIDTH, collapsed: false };
}

function fileIcon(file: LocalFile) {
  const known = file.share?.type && fileIconMap[file.share.type];
  if (known) return known;
  const extension = (file.displayName || file.share?.filename || "").split(".").pop()?.toLowerCase();
  if (extension === "pdf") return "fas fa-file-pdf";
  if (["md", "txt", "log", "rtf"].includes(extension || "")) return "fas fa-file-alt";
  if (["js", "ts", "tsx", "jsx", "html", "css", "json", "py", "java", "c", "cpp", "sh"].includes(extension || "")) return "fas fa-file-code";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "heic"].includes(extension || "")) return "fas fa-file-image";
  if (["zip", "gz", "tar", "7z", "rar"].includes(extension || "")) return "fas fa-file-archive";
  return "fas fa-file";
}

function ItemTooltip({ label, children }: { label: string; children: ReactElement }) {
  return <Tooltip.Root>
    <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content className="sidebar-tooltip" side="right" sideOffset={10} collisionPadding={8}>
        {label}
        <Tooltip.Arrow className="sidebar-tooltip-arrow" />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}

export default function Sidebar({ items, q, searching }: { items: SidebarItem[]; q: string | null; searching: boolean }) {
  const submit = useSubmit();
  const location = useLocation();
  const [preferences, setPreferences] = useState<Preferences>({ width: DEFAULT_WIDTH, collapsed: false });
  const preferencesRef = useRef(preferences);
  const [viewportWidth, setViewportWidth] = useState(1024);
  const [mobile, setMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [resizing, setResizing] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const mobileOpenerRef = useRef<HTMLElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearchRef = useRef(false);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number; original: Preferences }>();
  const maximum = Math.max(MIN_WIDTH, Math.min(480, viewportWidth - 320));
  const collapsed = mobile ? false : preferences.collapsed;
  const width = collapsed ? RAIL_WIDTH : mobile ? DEFAULT_WIDTH : Math.min(preferences.width, maximum);

  const updatePreferences = (next: Preferences, persist = true) => {
    preferencesRef.current = next;
    setPreferences(next);
    if (persist) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
      catch { /* Layout remains usable without local storage. */ }
    }
  };

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const refreshViewport = () => {
      setViewportWidth(window.innerWidth);
      const narrow = media.matches;
      setMobile(narrow);
      if (!narrow) setMobileOpen(false);
    };
    const saved = readPreferences();
    preferencesRef.current = saved;
    setPreferences(saved);
    refreshViewport();
    const sync = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      const next = readPreferences();
      preferencesRef.current = next;
      setPreferences(next);
    };
    window.addEventListener("resize", refreshViewport);
    media.addEventListener("change", refreshViewport);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("resize", refreshViewport);
      media.removeEventListener("change", refreshViewport);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    const opener = mobileOpenerRef.current || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const background = [document.getElementById("mobile-header"), document.getElementById("detail")]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element) => ({ element, inert: element.inert }));
    background.forEach(({ element }) => { element.inert = true; });
    if (!focusSearchRef.current) toggleRef.current?.focus({ preventScroll: true });
    const keys = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
      }
      if (event.key === "Tab") {
        const controls = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),[tabindex="0"]',
        ) || []).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !sidebarRef.current?.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !sidebarRef.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("keydown", keys);
      background.forEach(({ element, inert }) => { element.inert = inert; });
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      if (mobileOpenerRef.current === opener) mobileOpenerRef.current = null;
    };
  }, [mobileOpen]);
  useEffect(() => {
    document.body.classList.toggle("sidebar-resizing", resizing);
    return () => document.body.classList.remove("sidebar-resizing");
  }, [resizing]);
  useEffect(() => {
    if (!collapsed && (!mobile || mobileOpen) && focusSearchRef.current) {
      focusSearchRef.current = false;
      searchRef.current?.focus();
    }
  }, [collapsed, mobile, mobileOpen]);

  const toggle = () => {
    if (mobile) setMobileOpen(!mobileOpen);
    else updatePreferences({ ...preferencesRef.current, collapsed: !preferencesRef.current.collapsed });
  };
  const openMenu = (event: MouseEvent<HTMLButtonElement>) => {
    mobileOpenerRef.current = event.currentTarget;
    focusSearchRef.current = false;
    setMobileOpen(true);
  };
  const openSearch = (event: MouseEvent<HTMLButtonElement>) => {
    focusSearchRef.current = true;
    if (mobile) {
      mobileOpenerRef.current = event.currentTarget;
      setMobileOpen(true);
    }
    else updatePreferences({ ...preferencesRef.current, collapsed: false });
  };
  const closeDrawer = () => setMobileOpen(false);
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (mobile || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, original: preferencesRef.current };
    setResizing(true);
  };
  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const proposed = drag.startWidth + event.clientX - drag.startX;
    updatePreferences(proposed <= 120
      ? { ...preferencesRef.current, collapsed: true }
      : { width: Math.min(maximum, Math.max(MIN_WIDTH, proposed)), collapsed: false }, false);
  };
  const finishDrag = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = undefined;
    setResizing(false);
    updatePreferences(cancelled ? drag.original : preferencesRef.current, !cancelled);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const resizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mobile) return;
    const current = preferencesRef.current;
    let next: Preferences;
    if (event.key === "Home") next = { ...current, collapsed: true };
    else if (event.key === "End") next = { width: maximum, collapsed: false };
    else if (event.key === "ArrowRight") next = { width: current.collapsed ? Math.min(current.width, maximum) : Math.min(width + 24, maximum), collapsed: false };
    else if (event.key === "ArrowLeft") next = width <= MIN_WIDTH ? { ...current, collapsed: true } : { width: Math.max(MIN_WIDTH, width - 24), collapsed: false };
    else if (event.key === "Enter") next = { ...current, collapsed: !current.collapsed };
    else return;
    event.preventDefault();
    updatePreferences(next);
  };

  return <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
    <header id="mobile-header" aria-label="Mobile navigation">
      <button id="mobile-sidebar-toggle" className="mobile-toolbar-button" type="button" onClick={openMenu}
        aria-label="Open sidebar" aria-expanded={mobileOpen} aria-controls="sidebar">
        <i className="fas fa-bars" aria-hidden="true" />
      </button>
      <Link id="mobile-home" to="/" aria-label="Home" onClick={closeDrawer}>
        <img src="/svg/w2w_flat.svg" width="88" height="28" alt="" />
      </Link>
      <button id="mobile-search" className="mobile-toolbar-button" type="button" aria-label="Search files" onClick={openSearch}>
        <i className="fas fa-search" aria-hidden="true" />
      </button>
      <Form className="mobile-new-form" method="get" action="/new" onSubmit={closeDrawer}>
        <button id="mobile-new" className="mobile-toolbar-button" type="submit" aria-label="New">
          <i className="fas fa-plus" aria-hidden="true" />
        </button>
      </Form>
    </header>
    <aside ref={sidebarRef} id="sidebar" role={mobile ? "dialog" : undefined} aria-modal={mobile && mobileOpen || undefined}
      aria-label="File and text history" data-collapsed={collapsed} data-mobile-open={mobileOpen}
      style={{ "--sidebar-width": `${width}px` } as CSSProperties}>
      <Link to="/" aria-label="Home" onClick={closeDrawer}>
        <h1><span className="sidebar-home-label">Home</span></h1>
      </Link>
      <button ref={toggleRef} id="sidebar-toggle" type="button" onClick={toggle}
        aria-label={mobile ? "Close sidebar" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={mobile ? mobileOpen : !collapsed} aria-controls="sidebar-navigation">
        <i className={`fas ${mobile ? "fa-times" : collapsed ? "fa-chevron-right" : "fa-chevron-left"}`} aria-hidden="true" />
      </button>
      <div className="sidebar-toolbar">
        <button className="sidebar-search-button" type="button" aria-label="Search files" onClick={openSearch}>
          <i className="fas fa-search" aria-hidden="true" />
        </button>
        <Form id="search-form" onChange={(event) => submit(event.currentTarget, { replace: q !== null })} role="search">
          <input ref={searchRef} id="q" className={searching ? "loading" : ""} defaultValue={q || ""}
            aria-label="Search files" placeholder="Search" type="search" name="q" />
          <div id="search-spinner" hidden={!searching} aria-hidden />
        </Form>
        <Form className="sidebar-new-form" method="get" action="/new" onSubmit={closeDrawer}>
          <button type="submit" aria-label="New" style={{ width: "100%" }}>
            <i className="fas fa-plus sidebar-new-icon" aria-hidden="true" /><span className="sidebar-new-label">New</span>
          </button>
        </Form>
      </div>
      <nav id="sidebar-navigation">
        {items.length ? <ul>{items.map((item) => {
          const file = item.kind === "file" ? item.record : undefined;
          const text = item.kind === "text" ? item.record : undefined;
          const label = text ? `${text.title} #${text.token}` : file?.displayName || file?.share?.token
            ? `${file?.displayName || ""} #${file?.share?.token || "------"}`.trim() : "No Name";
          const token = file?.share?.token;
          const lastDate = file?.share?.lastAccessedAt;
          const days = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : 0;
          const isExpired = file?.status === "expired";
          const path = text ? `/texts/${text.id}` : `/files/${file!.shareId || file!.id}${file!.shareId ? "" : "/edit"}`;
          return <li key={`${item.kind}:${item.record.id}`}>
            <ItemTooltip label={label}>
              <NavLink className={({ isActive, isPending }) => isActive ? "active" : isPending ? "pending" : ""}
                to={path} onClick={closeDrawer} aria-label={label}
                style={{ textDecoration: isExpired ? "line-through" : "none" }}>
                <i className={`${file ? fileIcon(file) : "fas fa-file-code"} sidebar-file-icon`} aria-hidden="true" />
                <span className="sidebar-entry-label">{!text && !file?.displayName && !token ? <i>No Name</i> : label}</span>
                <span className="sidebar-entry-meta">
                  {file?.favorite ? <span className="sidebar-favorite">★</span> : null}
                  {days > 25 && days < 30 && <i className="fas fa-clock" style={{ color: "#ff6b6b", opacity: 0.6 }} title={`⚠️ Expiring soon (${30 - days} days left)`} />}
                  {isExpired && <i className="fas fa-trash" style={{ color: "#ccc", opacity: 0.6 }} title="Share expired (30+ days without access)" />}
                  <i className={file ? `fas ${file.direction === "seed" ? "fa-upload" : "fa-download"}` : "fas fa-file-code"}
                    title={file ? file.direction === "seed" ? "You seeded this file" : "You received this file" : "Saved text"} />
                </span>
              </NavLink>
            </ItemTooltip>
          </li>;
        })}</ul> : <p className="sidebar-empty"><i className="fas fa-folder-open sidebar-empty-icon" aria-hidden="true" /><i className="sidebar-empty-label">No files or texts</i></p>}
      </nav>
      {/* Focusable separators are interactive ARIA range widgets; the linter classifies every separator as static. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div id="sidebar-resizer" role="separator" tabIndex={0} aria-label="Resize sidebar" aria-orientation="vertical"
        aria-controls="sidebar" aria-valuemin={RAIL_WIDTH} aria-valuemax={maximum} aria-valuenow={width}
        aria-valuetext={collapsed ? "Collapsed" : `${Math.round(width)} pixels`}
        onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={(event) => finishDrag(event)}
        onPointerCancel={(event) => finishDrag(event, true)} onLostPointerCapture={(event) => finishDrag(event)}
        onKeyDown={resizeKey} onDoubleClick={() => updatePreferences({ width: Math.min(DEFAULT_WIDTH, maximum), collapsed: false })} />
    </aside>
    {mobileOpen && mobile ? <button className="sidebar-backdrop" type="button" aria-label="Close sidebar" onClick={closeDrawer} /> : null}
  </Tooltip.Provider>;
}
