import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import NoticeBoard from "./components/NoticeBoard";
import TabBar from "./components/TabBar";
import Admin from "./pages/Admin";
import Browse from "./pages/Browse";
import Home from "./pages/Home";
import Library from "./pages/Library";
import Profiles from "./pages/Profiles";
import Search from "./pages/Search";
import Title from "./pages/Title";
import Watch from "./pages/Watch";
import { useSession } from "./lib/session";

function ThemeSync() {
  const { state } = useSession();
  useEffect(() => {
    document.documentElement.dataset.theme = state.prefs.theme === "amoled" ? "amoled" : "dark";
  }, [state.prefs.theme]);
  return null;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [pathname]);
  return null;
}

function Guard({ children }: { children: ReactNode }) {
  const { ready, activeProfile } = useSession();

  if (!ready) {
    return (
      <div className="boot" role="status" aria-label="Loading LIGHTH00K">
        <div className="boot-core">
          <div className="boot-mark" aria-hidden="true">
            L
          </div>
          <div className="boot-wordmark" aria-hidden="true">
            LIGHTH00K
          </div>
          <div className="boot-tag" aria-hidden="true">
            Private cinema
          </div>
        </div>
      </div>
    );
  }

  if (!activeProfile) return <Navigate to="/profiles" replace />;

  return <>{children}</>;
}

export default function App() {
  const location = useLocation();
  const { activeProfile, syncStatus } = useSession();

  const showTabs =
    Boolean(activeProfile) && ["/", "/search", "/library"].includes(location.pathname);
  const showNotice =
    location.pathname !== "/admin" && !location.pathname.startsWith("/watch");

  const banner =
    activeProfile && syncStatus.error
      ? { message: syncStatus.error, error: syncStatus.online }
      : null;

  return (
    <div className="app">
      <ThemeSync />
      <ScrollToTop />

      {showNotice && <NoticeBoard />}

      {banner && (
        <div
          className={`offline-banner${banner.error ? " offline-banner--error" : ""}`}
          role="status"
        >
          <span aria-hidden="true">
            {banner.error ? (
              "!"
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                aria-hidden="true"
              >
                <path
                  d="M17.4 18H6.6a4 4 0 0 1-.4-7.98A6 6 0 0 1 17.7 8.5 4.25 4.25 0 0 1 17.4 18Z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          {banner.message}
        </div>
      )}

      <main className={`app-main${showTabs ? "" : " app-main--flush"}`}>
        <Routes>
          <Route path="/profiles" element={<Profiles />} />
          <Route path="/admin" element={<Admin />} />
          <Route
            path="/"
            element={
              <Guard>
                <Home />
              </Guard>
            }
          />
          <Route
            path="/search"
            element={
              <Guard>
                <Search />
              </Guard>
            }
          />
          <Route
            path="/title/:type/:id"
            element={
              <Guard>
                <Title />
              </Guard>
            }
          />
          <Route
            path="/watch/:type/:id"
            element={
              <Guard>
                <Watch />
              </Guard>
            }
          />
          <Route
            path="/library"
            element={
              <Guard>
                <Library />
              </Guard>
            }
          />
          <Route
            path="/browse/:kind"
            element={
              <Guard>
                <Browse />
              </Guard>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      {showTabs && <TabBar />}
    </div>
  );
}
