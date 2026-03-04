export {}; // Ensure this file is treated as a module

const API_BASE = "";

const loginScreen = document.getElementById("login-screen")!;
const adminPanel = document.getElementById("admin-panel")!;
const loginForm = document.getElementById("login-form") as HTMLFormElement;
const passwordInput = document.getElementById("password-input") as HTMLInputElement;
const loginError = document.getElementById("login-error")!;
const logoutBtn = document.getElementById("logout-btn")!;

function getToken(): string | null {
  return sessionStorage.getItem("adminToken");
}

function setToken(token: string): void {
  sessionStorage.setItem("adminToken", token);
}

function clearToken(): void {
  sessionStorage.removeItem("adminToken");
}

function showAdmin(): void {
  loginScreen.classList.add("hidden");
  adminPanel.classList.remove("hidden");
}

function showLogin(): void {
  adminPanel.classList.add("hidden");
  loginScreen.classList.remove("hidden");
  loginError.classList.add("hidden");
  passwordInput.value = "";
}

async function validateSession(): Promise<boolean> {
  const token = getToken();
  if (!token) return false;
  try {
    const res = await fetch(`${API_BASE}/api/admin/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

async function login(password: string): Promise<void> {
  loginError.classList.add("hidden");
  try {
    const res = await fetch(`${API_BASE}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (data.ok && data.token) {
      setToken(data.token);
      showAdmin();
    } else {
      loginError.textContent = data.error || "Invalid password";
      loginError.classList.remove("hidden");
    }
  } catch {
    loginError.textContent = "Could not reach server";
    loginError.classList.remove("hidden");
  }
}

// ── Event listeners ─────────────────────────────────────

loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const pw = passwordInput.value.trim();
  if (pw) login(pw);
});

logoutBtn.addEventListener("click", () => {
  clearToken();
  showLogin();
});

// ── Init ────────────────────────────────────────────────

(async () => {
  if (await validateSession()) {
    showAdmin();
  } else {
    clearToken();
    showLogin();
  }
})();
