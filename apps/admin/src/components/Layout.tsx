import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { NAV } from "../nav";
import { useAuth } from "../auth/AuthContext";
import { Button } from "./ui";

export function Layout() {
  const { user, logout, can } = useAuth();
  const [open, setOpen] = useState(false);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <aside className={`sidebar${open ? " open" : ""}`} aria-label="Primary">
        <div className="brand">Commerce Admin</div>
        <nav>
          {NAV.map((section, i) => {
            const items = section.items.filter((it) => !it.perm || can(it.perm));
            if (!items.length) return null;
            return (
              <div className="nav-section" key={section.title ?? i}>
                {section.title && <div className="nav-title">{section.title}</div>}
                {items.map((it) => (
                  <NavLink
                    key={it.path}
                    to={it.path}
                    end={it.path === "/"}
                    className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}
                    onClick={() => setOpen(false)}
                  >
                    {it.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="main-col">
        <header className="topbar">
          <button
            className="btn btn-ghost menu-btn"
            aria-label="Toggle navigation"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            ☰
          </button>
          <div className="spacer" />
          <span className="who">
            {user?.name}{" "}
            <small className="muted">({user?.role.replace(/_/g, " ").toLowerCase()})</small>
          </span>
          <Button variant="ghost" onClick={() => void logout()}>
            Sign out
          </Button>
        </header>
        <main id="main" className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
