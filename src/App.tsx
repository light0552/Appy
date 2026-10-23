import { useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import TabBar from "./components/TabBar";
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
      <div className="boot">
        <div className="boot-mark" aria-label="Loading Lighthook">
          L
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

  const banner =
    activeProfile && syncStatus.error
      ? { message: syncStatus.error, error: syncStatus.online }
      : null;

  return (
    <div className="app">
      <ThemeSync />
      <ScrollToTop />

      {banner && (
        <div
          className={`offline-banner${banner.error ? " offline-banner--error" : ""}`}
          role="status"
        >
          <span aria-hidden="true">{banner.error ? "!" : "☁"}</span>
          {banner.message}
        </div>
      )}

      <main className={`app-main${showTabs ? "" : " app-main--flush"}`}>
        <Routes>
          <Route path="/profiles" element={<Profiles />} />
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
