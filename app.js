      let learners = (
        JSON.parse(localStorage.getItem("sys_learners")) || [
          {
            lrn: "10928374001",
            name: "Juan De La Cruz",
            parentName: "Maria De La Cruz",
            phone: "09171234567",
          },
          {
            lrn: "10928374002",
            name: "Maria Clara Santos",
            parentName: "Jose Santos",
            phone: "09189876543",
          },
        ]
      ).map((learner) => ({
        ...learner,
        className: learner.className || "Unassigned",
        phone: normalizePhilippinePhone(learner.phone) || learner.phone || "",
        qrVersion: Number(learner.qrVersion) || 1,
      }));

      let logs = JSON.parse(localStorage.getItem("sys_attendance_logs")) || [];
      logs = logs.map((log) => ({
        ...log,
        className: log.className || "Unassigned",
      }));

      let settings = JSON.parse(localStorage.getItem("sys_settings")) || {
        mode: "webhook",
        webhookUrl: "http://localhost:3000/api/sms/send",
        smsClientToken: "",
        retentionDays: 0,
        timeInTemplate:
          "Dear {parent}, your child {name} (LRN: {lrn}) safely checked IN at school on {date} at {time}.",
        timeOutTemplate:
          "Dear {parent}, your child {name} (LRN: {lrn}) checked OUT of school on {date} at {time}. Have a safe commute!",
      };

      let currentAttendanceMode = "Time IN";
      let html5QrcodeScanner = null;
      let scanAlertTimeout = null;
      let toastId = 0;
      let accessMode = null;
      let currentUserEmail = null;
      let authToken = null;
      const API_BASE_URL = window.ATTENDANCE_API_URL || "http://localhost:3000";
      let auditTrail = JSON.parse(localStorage.getItem("sys_audit_trail")) || [];
      let pendingSmsQueue = JSON.parse(localStorage.getItem("sys_pending_sms")) || [];
      if (settings.mode === "simulation") settings.mode = "webhook";
      if (!settings.webhookUrl) settings.webhookUrl = "http://localhost:3000/api/sms/send";

      function showToast(message, type = "info", duration = 3500) {
        const region = document.getElementById("toast-region");
        if (!region) return;
        const toast = document.createElement("div");
        toast.className = `app-toast ${type}`;
        toast.setAttribute("role", type === "error" ? "alert" : "status");
        toast.dataset.toastId = String(++toastId);
        toast.textContent = message;
        region.appendChild(toast);
        window.setTimeout(() => toast.remove(), duration);
      }

      function recordAudit(action, details = "") {
        auditTrail.unshift({
          id: Date.now(),
          action,
          details,
          at: new Date().toISOString(),
          role: accessMode || "system",
        });
        auditTrail = auditTrail.slice(0, 1000);
        localStorage.setItem("sys_audit_trail", JSON.stringify(auditTrail));
      }

      function persistPendingSms() {
        localStorage.setItem("sys_pending_sms", JSON.stringify(pendingSmsQueue));
      }

      function normalizePhilippinePhone(rawPhone) {
        const digits = String(rawPhone || "").replace(/[^\d+]/g, "");
        if (/^09\d{9}$/.test(digits)) return `+63${digits.slice(1)}`;
        if (/^9\d{9}$/.test(digits)) return `+63${digits}`;
        if (/^639\d{9}$/.test(digits)) return `+${digits}`;
        if (/^\+639\d{9}$/.test(digits)) return digits;
        return "";
      }

      async function flushPendingSms() {
        if (!navigator.onLine || settings.mode !== "webhook" || !settings.webhookUrl || !pendingSmsQueue.length) return;
        const queued = [...pendingSmsQueue];
        pendingSmsQueue = [];
        persistPendingSms();
        const results = await Promise.all(queued.map((item) => dispatchSMS(item.phone, item.message, { notify: false })));
        const sent = results.filter((result) => result.status === "sent").length;
        const failed = results.filter((result) => result.status === "failed").length;
        const stillQueued = results.filter((result) => result.status === "queued").length;
        if (failed || stillQueued) {
          showToast(`${sent} queued message${sent === 1 ? "" : "s"} sent; ${failed} failed and ${stillQueued} remain queued.`, "warning");
        } else if (sent) {
          showToast(`Sent ${sent} queued message${sent === 1 ? "" : "s"}.`, "success");
        }
      }

      window.addEventListener("online", flushPendingSms);

      function initializeGoogleSignIn() {
        if (!window.google?.accounts?.id) {
          showGoogleSignInError();
          return;
        }

        google.accounts.id.initialize({
          client_id:
            "353978343877-cejn953ik7l7uqs7203sdr8asv2t72uc.apps.googleusercontent.com",
          callback: handleGoogleSignIn,
        });
        google.accounts.id.renderButton(
          document.getElementById("gsi-button"),
          { type: "icon", theme: "outline", size: "large", shape: "circle" },
        );
        google.accounts.id.renderButton(
          document.getElementById("signup-gsi-button"),
          { type: "icon", theme: "outline", size: "large", shape: "circle" },
        );
      }

      function handleGoogleSignIn(response) {
        if (!response || !response.credential) {
          showGoogleSignInError();
          return;
        }
        // A Google ID token must be verified by the backend before it can
        // grant access. This API currently supports email/password login only.
        const error = document.getElementById("auth-error");
        error.innerText = "Google sign-in is not connected to the server yet. Please sign in with your administrator email and password.";
        error.classList.remove("hidden");
      }

      function continueAsGuest() {
        enterApp("guest", "Guest mode");
      }

      async function signInWithEmail(event) {
        event.preventDefault();
        const email = document.getElementById("auth-email").value.trim().toLowerCase();
        const password = document.getElementById("auth-password").value;
        const remember = document.getElementById("auth-remember").checked;
        const submitButton = document.querySelector(".auth-submit-button");
        const error = document.getElementById("auth-error");

        if (!email || !email.includes("@") || password.length < 6) {
          error.innerText = "Enter a valid email and a password with at least 6 characters.";
          error.classList.remove("hidden");
          return;
        }

        error.classList.add("hidden");
        submitButton.disabled = true;
        submitButton.setAttribute("aria-busy", "true");
        submitButton.textContent = "Signing in…";
        try {
          const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok || !result.token || !result.user || !["admin", "staff", "viewer"].includes(result.user.role)) {
            throw new Error(response.status === 401 ? "Email or password is incorrect." : (result.error || "Unable to sign in."));
          }

          authToken = result.token;
          const session = { token: result.token, user: result.user, signedInAt: new Date().toISOString() };
          if (remember) {
            localStorage.setItem("sys_auth_session", JSON.stringify(session));
            sessionStorage.removeItem("sys_auth_session");
          } else {
            sessionStorage.setItem("sys_auth_session", JSON.stringify(session));
            localStorage.removeItem("sys_auth_session");
          }
          enterApp(result.user.role, result.user.email);
        } catch (signInError) {
          error.innerText = signInError instanceof TypeError
            ? "Could not reach the sign-in server. Make sure the backend is running, then try again."
            : signInError.message;
          error.classList.remove("hidden");
        } finally {
          submitButton.disabled = false;
          submitButton.removeAttribute("aria-busy");
          submitButton.textContent = "Sign in";
        }
      }

      function toggleAuthPassword() {
        const password = document.getElementById("auth-password");
        const toggle = document.querySelector(".password-toggle");
        const visible = password.type === "text";
        password.type = visible ? "password" : "text";
        toggle.textContent = visible ? "Show" : "Hide";
        toggle.setAttribute("aria-label", visible ? "Show password" : "Hide password");
      }

      function forgotPassword() {
        showToast("Password recovery needs to be connected to your backend email service.", "info");
      }

      function showSignUpNotice() {
        document.getElementById("auth-login-view").classList.add("hidden");
        document.getElementById("auth-signup-view").classList.remove("hidden");
        document.getElementById("auth-screen").classList.add("signup-active");
        document.querySelector(".auth-card-frame").classList.add("signup-active");
        document.getElementById("auth-error").classList.add("hidden");
        document.getElementById("signup-name").focus();
      }

      function showSignInView() {
        document.getElementById("email-signup-form").reset();
        document.querySelector(".auth-signup-status").textContent =
          "Registration is not available yet. Your details will not be submitted.";
        document.getElementById("auth-signup-view").classList.add("hidden");
        document.getElementById("auth-login-view").classList.remove("hidden");
        document.getElementById("auth-screen").classList.remove("signup-active");
        document.querySelector(".auth-card-frame").classList.remove("signup-active");
        document.getElementById("auth-error").classList.add("hidden");
      }

      function submitSignUp(event) {
        event.preventDefault();
        const password = document.getElementById("signup-password").value;
        const confirmation = document.getElementById("signup-password-confirm").value;
        const status = document.querySelector(".auth-signup-status");

        status.textContent = password === confirmation
          ? "Account registration is not connected yet. Your details were not submitted."
          : "Those passwords do not match. Please check them and try again.";
      }

      function requireAdmin() {
        if (accessMode === "admin" || accessMode === "staff") return true;
        alert(accessMode === "viewer" ? "Your account has read-only access." : "Sign in with an authorized account to use editing and management features.");
        return false;
      }

      function enterApp(mode, identity = null) {
        accessMode = mode;
        currentUserEmail = identity || (mode === "guest" ? "Guest mode" : "Signed-in user");
        populateCameraDevices();
        document.getElementById("scan-tip").textContent =
          mode === "guest"
            ? "Guest mode: enter a learner's LRN to record attendance. Management tools require Google sign-in."
            : "Tip: You can edit notification templates under the Message & SMS Setup tab anytime.";
        document
          .querySelectorAll("#sidebar .tab-btn")
          .forEach((button) => {
            const scannerButton = button.id === "btn-scan-tab";
            button.classList.toggle(
              "hidden",
              mode === "guest" && !scannerButton,
            );
          });
        document.getElementById("menu-toggle").classList.toggle(
          "hidden",
          mode === "guest",
        );
        document.getElementById("signout-btn").innerText =
          mode === "guest" ? "Exit guest mode" : "Sign out";
        const userBadge = document.getElementById("user-badge");
        userBadge.innerText = currentUserEmail;
        userBadge.classList.remove("hidden");
        document.getElementById("auth-screen").classList.add("hidden");
        document.getElementById("app-layout").classList.remove("hidden");
        document.getElementById("signout-btn").classList.remove("hidden");
        document.getElementById("auth-error").classList.add("hidden");
        switchTab("scan-tab");
      }

      function signOut() {
        if (window.google?.accounts?.id) {
          google.accounts.id.disableAutoSelect();
        }
        accessMode = null;
        currentUserEmail = null;
        authToken = null;
        localStorage.removeItem("sys_auth_session");
        sessionStorage.removeItem("sys_auth_session");
        stopCameraStream();
        closeMenu();
        document.getElementById("menu-toggle").classList.remove("hidden");
        document.getElementById("signout-btn").innerText = "Sign out";
        document
          .querySelectorAll("#sidebar .tab-btn")
          .forEach((button) => button.classList.remove("hidden"));
        document.getElementById("app-layout").classList.add("hidden");
        document.getElementById("signout-btn").classList.add("hidden");
        document.getElementById("user-badge").classList.add("hidden");
        document.getElementById("auth-screen").classList.remove("hidden");
        document.getElementById("auth-password").value = "";
      }

      async function restoreAuthSession() {
        let raw = localStorage.getItem("sys_auth_session") || sessionStorage.getItem("sys_auth_session");
        if (!raw) return;
        try {
          const session = JSON.parse(raw);
            if (session?.token && session?.user?.email && ["admin", "staff", "viewer"].includes(session.user.role)) {
            const response = await fetch(`${API_BASE_URL}/api/auth/me`, {
              headers: { Authorization: `Bearer ${session.token}` },
            });
            if (response.status === 401) {
              localStorage.removeItem("sys_auth_session");
              sessionStorage.removeItem("sys_auth_session");
              return;
            }
            if (!response.ok) throw new Error("Session validation failed");
            const result = await response.json();
            if (!["admin", "staff", "viewer"].includes(result.user?.role)) throw new Error("Account role is not authorized");
            authToken = session.token;
            enterApp(result.user.role, result.user.email);
          }
        } catch (_) {
          // Keep a remembered session if the server is temporarily offline,
          // but do not open the protected UI until the backend validates it.
          const error = document.getElementById("auth-error");
          error.innerText = "Could not validate your saved sign-in. Check that the backend is running, then sign in again.";
          error.classList.remove("hidden");
        }
      }

      function showGoogleSignInError() {
        const error = document.getElementById("auth-error");
        if (!error) return;
        error.innerText =
          "Google Sign-In is unavailable. Use your administrator email and password instead.";
        error.classList.remove("hidden");
      }

      window.addEventListener("DOMContentLoaded", () => {
        applyTheme();
        updateClock();
        setInterval(updateClock, 1000);
        document.getElementById("filter-log-date").value =
          getLocalDateKey(new Date());
        renderLearnersTable();
        renderLogsTable();
        loadSettingsUI();
        updateBrigadeCount();
        restoreAuthSession();
      });

      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && document.getElementById("sidebar").classList.contains("is-open")) {
          closeMenu();
          document.getElementById("menu-toggle").focus();
        }
      });

      function switchTab(tabId) {
        if (accessMode === "guest" && tabId !== "scan-tab") {
          return;
        }
        closeMenu();

        document
          .querySelectorAll(".tab-content")
          .forEach((el) => el.classList.add("hidden"));

        document
          .querySelectorAll(".tab-btn")
          .forEach((el) => el.classList.remove("active-tab"));

        document.getElementById(tabId).classList.remove("hidden");
        document.getElementById(`btn-${tabId}`).classList.add("active-tab");

        if (tabId === "scan-tab") {
          handleSourceChange();
        } else {
          stopCameraStream();
        }
      }

      function toggleMenu() {
        const menu = document.getElementById("sidebar");
        const backdrop = document.getElementById("sidebar-backdrop");
        const toggle = document.getElementById("menu-toggle");
        const isExpanded = menu.classList.contains("is-open");

        menu.classList.toggle("is-open", !isExpanded);
        backdrop.classList.toggle("is-visible", !isExpanded);
        toggle.setAttribute("aria-expanded", String(!isExpanded));
        toggle.setAttribute(
          "aria-label",
          isExpanded ? "Open section menu" : "Close section menu",
        );
      }

      function closeMenu() {
        document.getElementById("sidebar").classList.remove("is-open");
        document
          .getElementById("sidebar-backdrop")
          .classList.remove("is-visible");
        const toggle = document.getElementById("menu-toggle");
        toggle.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-label", "Open section menu");
      }

      function applyTheme() {
        const isDark = localStorage.getItem("sys_theme") === "dark";
        document.body.classList.toggle("dark-mode", isDark);
        document
          .getElementById("theme-toggle")
          .setAttribute("aria-pressed", String(isDark));
        document.getElementById("theme-toggle").innerText = isDark
          ? "☀️ Light"
          : "🌙 Dark";
      }

      function toggleTheme() {
        const isDark = !document.body.classList.contains("dark-mode");
        localStorage.setItem("sys_theme", isDark ? "dark" : "light");
        applyTheme();
      }

      function updateClock() {
        const now = new Date();
        document.getElementById("system-time").innerText =
          now.toLocaleTimeString() + " | " + now.toLocaleDateString();
      }

      function setAttendanceMode(mode) {
        currentAttendanceMode = mode;
        const btnIn = document.getElementById("btn-mode-in");
        const btnOut = document.getElementById("btn-mode-out");

        if (mode === "Time IN") {
          btnIn.className =
            "flex-1 py-3 text-lg font-bold rounded-xl border-2 border-green-600 bg-green-600 text-white shadow-md";
          btnOut.className =
            "flex-1 py-3 text-lg font-bold rounded-xl border-2 border-amber-500 bg-white text-amber-600 hover:bg-amber-50";
        } else {
          btnOut.className =
            "flex-1 py-3 text-lg font-bold rounded-xl border-2 border-amber-500 bg-amber-500 text-white shadow-md";
          btnIn.className =
            "flex-1 py-3 text-lg font-bold rounded-xl border-2 border-green-600 bg-white text-green-600 hover:bg-green-50";
        }
      }

      async function populateCameraDevices() {
        const select = document.getElementById("camera-select");
        try {
          const devices = await Html5Qrcode.getCameras();
          if (devices && devices.length > 0) {
            devices.forEach((device) => {
              if ([...select.options].some((option) => option.value === device.id)) {
                return;
              }
              const opt = document.createElement("option");
              opt.value = device.id;
              opt.innerText = `📷 Camera: ${device.label || "Camera Lens " + select.length}`;
              select.appendChild(opt);
            });
          }
        } catch (err) {
          console.warn("Camera listing error or permission pending:", err);
        }
      }

      function handleSourceChange() {
        const selectedVal = document.getElementById("camera-select").value;
        const hwBox = document.getElementById("hardware-scanner-box");
        const camContainer = document.getElementById("camera-container");

        if (selectedVal === "bluetooth") {
          stopCameraStream();
          camContainer.classList.add("hidden");
          hwBox.classList.remove("hidden");
          document.getElementById("hardware-input").focus();
        } else {
          hwBox.classList.add("hidden");
          camContainer.classList.remove("hidden");
          startCameraStream(selectedVal);
        }
      }

      function startCameraStream(cameraId) {
        stopCameraStream();
        document.getElementById("camera-fallback-text").innerText =
          "Initializing selected camera lens...";

        html5QrcodeScanner = new Html5Qrcode("reader");
        html5QrcodeScanner
          .start(
            cameraId,
            { fps: 10, qrbox: { width: 250, height: 250 } },
            (decodedText) => processAttendanceScan(decodedText.trim()),
            (errorMessage) => {},
          )
          .then(() => {
            document.getElementById("camera-fallback-text").innerText = "";
          })
          .catch((err) => {
            document.getElementById("camera-fallback-text").innerText =
              "Unable to open camera. Ensure browser permissions are allowed.";
          });
      }

      function stopCameraStream() {
        if (html5QrcodeScanner) {
          html5QrcodeScanner
            .stop()
            .then(() => {
              html5QrcodeScanner.clear();
              html5QrcodeScanner = null;
            })
            .catch((err) => console.log(err));
        }
      }

      function handleHardwareKeyPress(e) {
        if (e.key === "Enter") {
          processHardwareInput();
        }
      }

      function processHardwareInput() {
        if (!accessMode) return;
        const inputEl = document.getElementById("hardware-input");
        const scannedLRN = inputEl.value.trim();
        if (scannedLRN) {
          processAttendanceScan(scannedLRN);
          inputEl.value = "";
        }
      }

      function processAttendanceScan(rawLRN) {
        if (!accessMode) return;
        const qrPayload = parseQrPayload(rawLRN);
        const scannedLRN = qrPayload.lrn;
        if (!scannedLRN) return;
        playBeepSound();

        const student = learners.find(
          (l) => l.lrn.toLowerCase() === scannedLRN.toLowerCase(),
        );
        if (!student) {
          showScanFeedback(
            `Unknown learner: LRN "${scannedLRN}" is not in the learner directory.`,
            "error",
          );
          return;
        }
        if (qrPayload.version && qrPayload.version !== (student.qrVersion || 1)) {
          showScanFeedback(
            "This QR code has been replaced. Generate a new QR code for this learner.",
            "error",
          );
          return;
        }

        const now = new Date();
        const dateKey = getLocalDateKey(now);
        const dateStr = now.toLocaleDateString();
        const alreadyRecorded = logs.some(
          (log) =>
            log.lrn.toLowerCase() === student.lrn.toLowerCase() &&
            getLogDateKey(log) === dateKey &&
            log.mode === currentAttendanceMode,
        );
        if (alreadyRecorded) {
          showScanFeedback(
            `${student.name} already has a ${currentAttendanceMode} record for today.`,
            "warning",
          );
          return;
        }

        logs = logs.filter(
          (log) =>
            !(
              log.lrn.toLowerCase() === student.lrn.toLowerCase() &&
              getLogDateKey(log) === dateKey &&
              log.mode === "Absent"
            ),
        );

        const timestampStr = now.toLocaleTimeString();
        showScanFeedback(
          `${currentAttendanceMode} successful: ${student.name} (${student.lrn}).`,
          "success",
        );

        const template =
          currentAttendanceMode === "Time IN"
            ? settings.timeInTemplate
            : settings.timeOutTemplate;
        const smsText = template
          .replace(/{name}/g, student.name)
          .replace(/{parent}/g, student.parentName)
          .replace(/{lrn}/g, student.lrn)
          .replace(/{time}/g, timestampStr)
          .replace(/{date}/g, dateStr);

        const logEntry = {
          id: Date.now(),
          date: dateStr,
          dateKey,
          timestamp: now.toISOString(),
          time: timestampStr,
          lrn: student.lrn,
          name: student.name,
          parentName: student.parentName,
          phone: student.phone,
          className: student.className || "Unassigned",
          mode: currentAttendanceMode,
          smsStatus: settings.mode === "simulation" ? "Simulated" : "Pending",
        };

        logs.unshift(logEntry);
        localStorage.setItem("sys_attendance_logs", JSON.stringify(logs));
        recordAudit("Recorded attendance", `${student.name} - ${currentAttendanceMode}`);
        renderLogsTable();
        renderRecentScansUI();
        if (settings.mode !== "simulation") {
          dispatchSMS(student.phone, smsText, { notify: false }).then((result) => {
            const savedLog = logs.find((log) => log.id === logEntry.id);
            if (!savedLog) return;
            savedLog.smsStatus = result.status === "sent"
              ? "Sent"
              : result.status === "queued"
                ? "Queued"
                : "Failed";
            localStorage.setItem("sys_attendance_logs", JSON.stringify(logs));
            renderLogsTable();
            renderRecentScansUI();
            if (result.status === "queued") {
              showToast("Attendance was recorded; SMS is queued and will retry when the connection is available.", "warning");
            } else if (result.status === "failed") {
              showToast(`Attendance was recorded, but SMS was not sent: ${result.message}.`, "error", 6000);
            }
          });
        }
      }

      function parseQrPayload(rawValue) {
        const value = String(rawValue || "").trim();
        if (!value) return { lrn: "", version: null };
        try {
          const payload = JSON.parse(value);
          return {
            lrn: String(payload.lrn || "").trim(),
            version: Number(payload.version) || null,
          };
        } catch (_) {
          return { lrn: value, version: null };
        }
      }

      function showLearnerQR(lrn) {
        if (!requireAdmin()) return;
        const learner = learners.find((item) => item.lrn === lrn);
        if (!learner) return;

        const payload = JSON.stringify({
          lrn: learner.lrn,
          name: learner.name,
          parentName: learner.parentName,
          className: learner.className || "Unassigned",
          version: learner.qrVersion || 1,
        });
        const output = document.getElementById("qr-code-output");
        output.replaceChildren();
        new QRCode(output, {
          text: payload,
          width: 240,
          height: 240,
          colorDark: "#0f172a",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M,
        });

        document.getElementById("qr-learner-name").textContent = learner.name;
        document.getElementById("qr-parent-name").textContent = learner.parentName;
        document.getElementById("qr-class-name").textContent = learner.className || "Unassigned";
        document.getElementById("qr-lrn").textContent = learner.lrn;
        document.getElementById("qr-version").textContent = learner.qrVersion || 1;
        document.getElementById("qr-modal").dataset.lrn = learner.lrn;
        document.getElementById("qr-modal").classList.remove("hidden");
      }

      function regenerateCurrentQr() {
        const lrn = document.getElementById("qr-modal").dataset.lrn;
        const learner = learners.find((item) => item.lrn === lrn);
        if (!learner || !confirm("Regenerate this QR code? The previous QR code will stop working.")) return;
        learner.qrVersion = (learner.qrVersion || 1) + 1;
        localStorage.setItem("sys_learners", JSON.stringify(learners));
        showLearnerQR(learner.lrn);
        showToast("QR code regenerated. The previous code is now revoked.", "success");
      }

      function closeQrModal() {
        document.getElementById("qr-modal").classList.add("hidden");
      }

      function downloadQrCode() {
        const output = document.getElementById("qr-code-output");
        const image = output.querySelector("img");
        const canvas = output.querySelector("canvas");
        const dataUrl = image?.src || canvas?.toDataURL("image/png");
        if (!dataUrl) return;
        const lrn = document.getElementById("qr-lrn").textContent || "learner";
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = `QR_${lrn}.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
      }

      function printAllLearnerQRCards() {
        if (!requireAdmin()) return;
        if (!learners.length) {
          showToast("Add at least one learner before printing QR cards.", "warning");
          return;
        }
        const printWindow = window.open("", "_blank", "width=1000,height=800");
        if (!printWindow) {
          showToast("Allow pop-ups to print QR cards.", "error");
          return;
        }
        const scratch = document.createElement("div");
        scratch.style.cssText = "position:fixed;left:-10000px;top:-10000px";
        document.body.appendChild(scratch);
        const cards = learners.map((learner) => {
          scratch.replaceChildren();
          const payload = JSON.stringify({
            lrn: learner.lrn,
            name: learner.name,
            parentName: learner.parentName,
            className: learner.className || "Unassigned",
            version: learner.qrVersion || 1,
          });
          new QRCode(scratch, {
            text: payload,
            width: 180,
            height: 180,
            colorDark: "#0f172a",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M,
          });
          const image = scratch.querySelector("img");
          const canvas = scratch.querySelector("canvas");
          const dataUrl = image?.src || canvas?.toDataURL("image/png") || "";
          return {
            image: dataUrl,
            name: learner.name,
            parentName: learner.parentName,
            className: learner.className || "Unassigned",
            lrn: learner.lrn,
          };
        });
        scratch.remove();
        printWindow.document.write(`<!doctype html><html><head><title>Learner QR Cards</title><style>
          *{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;padding:16px;color:#0f172a}
          .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{border:2px solid #cbd5e1;border-radius:12px;padding:14px;text-align:center;break-inside:avoid}
          img{width:180px;height:180px}.school{font-size:12px;color:#475569;margin-bottom:6px}.name{font-size:17px;font-weight:700;margin-top:8px}.meta{font-size:12px;margin-top:4px;color:#334155}
          @media print{body{padding:0}.grid{gap:10px}.card{border:1px solid #94a3b8}}
        </style></head><body><div class="grid">${cards
          .map(
            (card) => `<article class="card"><div class="school">Learner Attendance System</div><img src="${card.image}" alt="QR code for ${escapeHTML(card.name)}"><div class="name">${escapeHTML(card.name)}</div><div class="meta">${escapeHTML(card.className)}</div><div class="meta">LRN: ${escapeHTML(card.lrn)}</div><div class="meta">Parent: ${escapeHTML(card.parentName)}</div></article>`,
          )
          .join("")}</div><script>window.onload=()=>setTimeout(()=>window.print(),250);<\/script></body></html>`);
        printWindow.document.close();
      }

      function showScanFeedback(message, type) {
        const alertBox = document.getElementById("scan-alert");
        const styles = {
          success: "bg-green-500 text-white",
          warning: "bg-amber-100 text-amber-900",
          error: "bg-red-600 text-white",
        };

        alertBox.className = `p-4 rounded-xl text-center text-lg font-bold shadow-lg ${styles[type]}`;
        alertBox.setAttribute("role", type === "success" ? "status" : "alert");
        alertBox.setAttribute("aria-live", "assertive");
        alertBox.textContent = message;
        if (scanAlertTimeout) clearTimeout(scanAlertTimeout);
        scanAlertTimeout = setTimeout(
          () => alertBox.classList.add("hidden"),
          5000,
        );
      }

      function getLocalDateKey(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
      }

      function getLogDateKey(log) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(log.dateKey || "")) {
          return log.dateKey;
        }
        const parsedDate = new Date(log.date);
        return Number.isNaN(parsedDate.getTime())
          ? ""
          : getLocalDateKey(parsedDate);
      }

      function getLogTimeMinutes(log) {
        if (log.timestamp) {
          const date = new Date(log.timestamp);
          if (!Number.isNaN(date.getTime())) {
            return date.getHours() * 60 + date.getMinutes();
          }
        }

        const match = String(log.time || "").match(
          /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i,
        );
        if (!match) return null;

        let hours = Number(match[1]);
        const minutes = Number(match[2]);
        if (match[3]) {
          const period = match[3].toUpperCase();
          if (hours === 12) hours = 0;
          if (period === "PM") hours += 12;
        }
        return hours * 60 + minutes;
      }

      function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, (character) => {
          const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          };
          return entities[character];
        });
      }

      function playBeepSound() {
        try {
          const ctx = new (window.AudioContext || window.webkitAudioContext)();
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.setValueAtTime(800, ctx.currentTime);
          osc.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.15);
        } catch (e) {}
      }

      async function dispatchSMS(phone, message, { notify = true } = {}) {
        const normalizedPhone = normalizePhilippinePhone(phone);
        if (!normalizedPhone) {
          if (notify) showToast("SMS skipped: invalid Philippine mobile number.", "error");
          return { status: "failed", message: "Invalid mobile number" };
        }
        if (settings.mode === "simulation") {
          if (notify) showToast(`Simulation SMS sent to ${normalizedPhone}.`, "success");
          return { status: "sent", simulated: true };
        }
        if (settings.mode !== "webhook" || !settings.webhookUrl) {
          if (notify) showToast("SMS service is not configured. Check SMS settings.", "error");
          return { status: "failed", message: "SMS service is not configured" };
        }

        const queueMessage = (messageText) => {
          pendingSmsQueue.push({ phone: normalizedPhone, message, queuedAt: new Date().toISOString() });
          persistPendingSms();
          if (notify) showToast(messageText, "warning");
          return { status: "queued", message: messageText };
        };

        if (!navigator.onLine) {
          return queueMessage("Offline: message queued for delivery.");
        }

        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(settings.webhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
              ...(settings.smsClientToken ? { "X-SMS-Client-Token": settings.smsClientToken } : {}),
            },
            body: JSON.stringify({ phone: normalizedPhone, message: message }),
            signal: controller.signal,
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            const messageText = result.error || `SMS service returned HTTP ${response.status}.`;
            if (response.status >= 500 || response.status === 429) {
              return queueMessage("SMS service is temporarily unavailable; message queued for retry.");
            }
            if (notify) showToast(messageText, response.status === 401 || response.status === 403 ? "error" : "warning");
            return { status: "failed", message: messageText, httpStatus: response.status };
          }
          return { status: "sent", data: result };
        } catch (err) {
          console.error("Webhook SMS error:", err);
          if (err.name === "AbortError") {
            return queueMessage("SMS request timed out; message queued for retry.");
          }
          return queueMessage("Message delivery failed; queued for retry.");
        } finally {
          window.clearTimeout(timeoutId);
        }
      }

      function renderRecentScansUI() {
        const listEl = document.getElementById("recent-scans-list");
        const todayKey = getLocalDateKey(new Date());
        const todayLogs = logs
          .filter(
            (log) =>
              getLogDateKey(log) === todayKey && log.mode !== "Absent",
          )
          .slice(0, 6);

        if (todayLogs.length === 0) {
          listEl.innerHTML =
            '<p class="text-gray-400 text-center py-6">No scans recorded today yet.</p>';
          return;
        }

        listEl.innerHTML = todayLogs
          .map(
            (l) => `
                <div class="p-3 rounded-xl border flex justify-between items-center ${l.mode === "Time IN" ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200"}">
                    <div>
                        <p class="font-bold text-gray-800">${l.name}</p>
                        <p class="text-xs text-gray-500">${l.lrn} | ${l.time}</p>
                    </div>
                    <span class="text-xs font-bold px-2.5 py-1 rounded-full ${l.mode === "Time IN" ? "bg-green-600 text-white" : "bg-amber-600 text-white"}">${l.mode}</span>
                </div>
            `,
          )
          .join("");
      }

      function saveLearner(e) {
        if (!requireAdmin()) return;
        e.preventDefault();
        const lrn = document.getElementById("form-lrn").value.trim();
        const name = document.getElementById("form-name").value.trim();
        const parentName = document.getElementById("form-parent").value.trim();
        const rawPhone = document.getElementById("form-phone").value.trim();
        const phone = normalizePhilippinePhone(rawPhone);
        const className =
          document.getElementById("form-class").value.trim() || "Unassigned";
        const originalLrn = document.getElementById("edit-original-lrn").value;

        if (!/^\d{6,15}$/.test(lrn)) {
          showToast("LRN / Student ID must contain 6–15 digits.", "error");
          return;
        }
        if (!phone) {
          showToast("Enter a valid Philippine mobile number, such as 09171234567.", "error");
          return;
        }

        if (originalLrn) {
          const idx = learners.findIndex((l) => l.lrn === originalLrn);
          if (idx !== -1) {
            learners[idx] = {
              lrn,
              name,
              parentName,
              phone,
              className,
              qrVersion: (learners[idx].qrVersion || 1) + 1,
            };
          }
        } else {
          if (learners.some((l) => l.lrn === lrn)) {
            showToast("A learner with this LRN already exists.", "error");
            return;
          }
          learners.push({ lrn, name, parentName, phone, className, qrVersion: 1 });
        }

        localStorage.setItem("sys_learners", JSON.stringify(learners));
        recordAudit(originalLrn ? "Updated learner" : "Added learner", `${name} (${lrn})`);
        resetLearnerForm();
        renderLearnersTable();
        renderLogsTable();
        updateBrigadeCount();
        showToast("Learner saved successfully.", "success");
      }

      function editLearner(lrn) {
        if (!requireAdmin()) return;
        const student = learners.find((l) => l.lrn === lrn);
        if (!student) return;

        document.getElementById("edit-original-lrn").value = student.lrn;
        document.getElementById("form-lrn").value = student.lrn;
        document.getElementById("form-name").value = student.name;
        document.getElementById("form-parent").value = student.parentName;
        document.getElementById("form-phone").value = student.phone;
        document.getElementById("form-class").value =
          student.className === "Unassigned" ? "" : student.className;

        document.getElementById("form-title").innerText =
          "✏️ Edit Learner Details";
        document.getElementById("btn-save-learner").innerText =
          "Update Learner";
      }

      function deleteLearner(lrn) {
        if (!requireAdmin()) return;
        if (confirm(`Are you sure you want to delete learner LRN: ${lrn}?`)) {
          learners = learners.filter((l) => l.lrn !== lrn);
          localStorage.setItem("sys_learners", JSON.stringify(learners));
          recordAudit("Deleted learner", lrn);
          renderLearnersTable();
          renderLogsTable();
          updateBrigadeCount();
        }
      }

      function resetLearnerForm() {
        document.getElementById("learner-form").reset();
        document.getElementById("edit-original-lrn").value = "";
        document.getElementById("form-title").innerText = "➕ Add New Learner";
        document.getElementById("btn-save-learner").innerText = "Save Learner";
      }

      function renderLearnersTable() {
        const tbody = document.getElementById("learners-table-body");
        const query = document
          .getElementById("search-learner")
          .value.toLowerCase();
        const filtered = learners.filter(
          (l) =>
            l.name.toLowerCase().includes(query) ||
            l.lrn.toLowerCase().includes(query) ||
            l.parentName.toLowerCase().includes(query) ||
            (l.className || "Unassigned").toLowerCase().includes(query),
        );

        if (filtered.length === 0) {
          tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-gray-400">No matching learners found.</td></tr>`;
          return;
        }

        tbody.innerHTML = filtered
          .map(
            (l) => `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5 font-mono font-bold">${l.lrn}</td>
                    <td class="p-2.5">${l.name}</td>
                    <td class="p-2.5">${l.parentName}</td>
                    <td class="p-2.5 font-mono">${l.phone}</td>
                    <td class="p-2.5">${escapeHTML(l.className || "Unassigned")}</td>
                    <td class="p-2.5 align-middle">
                        <div class="flex min-w-[92px] flex-col gap-1.5">
                            <button onclick="showLearnerQR(this.dataset.lrn)" data-lrn="${escapeHTML(l.lrn)}" class="w-full rounded-md bg-blue-50 px-2 py-1.5 text-xs font-bold text-blue-700 transition hover:bg-blue-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-400">QR Code</button>
                            <div class="grid grid-cols-2 gap-1.5">
                                <button onclick="editLearner('${l.lrn}')" class="rounded-md bg-amber-50 px-2 py-1.5 text-xs font-bold text-amber-700 transition hover:bg-amber-500 hover:text-white focus:outline-none focus:ring-2 focus:ring-amber-400">Edit</button>
                                <button onclick="deleteLearner('${l.lrn}')" class="rounded-md bg-red-50 px-2 py-1.5 text-xs font-bold text-red-700 transition hover:bg-red-600 hover:text-white focus:outline-none focus:ring-2 focus:ring-red-400">Delete</button>
                            </div>
                        </div>
                    </td>
                </tr>
            `,
          )
          .join("");
      }

      function exportLearnersCSV() {
        if (!requireAdmin()) return;
        let csv = "LRN,Full Name,Parent Name,Phone Number,Class / Section\n";
        learners.forEach((l) => {
          csv += `"${l.lrn}","${l.name}","${l.parentName}","${l.phone}","${l.className || "Unassigned"}"\n`;
        });
        downloadCSV(
          csv,
          `Learner_Directory_${new Date().toISOString().slice(0, 10)}.csv`,
        );
      }

      function importLearnersCSV(e) {
        if (!requireAdmin()) return;
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (evt) {
          const lines = evt.target.result.split("\n").slice(1);
          let count = 0;
          lines.forEach((line) => {
            const cols = parseCSVLine(line);
            if (cols.length >= 4 && cols[0]) {
              if (!learners.some((l) => l.lrn === cols[0])) {
                learners.push({
                  lrn: cols[0],
                  name: cols[1],
                  parentName: cols[2],
                  phone: normalizePhilippinePhone(cols[3]) || cols[3],
                  className: cols[4] || "Unassigned",
                  qrVersion: 1,
                });
                count++;
              }
            }
          });
          localStorage.setItem("sys_learners", JSON.stringify(learners));
          renderLearnersTable();
          renderLogsTable();
          updateBrigadeCount();
          showToast(`Imported ${count} new learner${count === 1 ? "" : "s"}.`, "success");
        };
        reader.readAsText(file);
      }

      function updateBrigadeCount() {
        document.getElementById("brigade-recipient-count").innerText =
          learners.length;
      }

      function parseCSVLine(line) {
        const columns = [];
        let value = "";
        let quoted = false;
        for (let i = 0; i < line.length; i += 1) {
          const character = line[i];
          if (character === '"' && line[i + 1] === '"' && quoted) {
            value += '"';
            i += 1;
          } else if (character === '"') {
            quoted = !quoted;
          } else if (character === "," && !quoted) {
            columns.push(value.trim());
            value = "";
          } else {
            value += character;
          }
        }
        columns.push(value.trim());
        return columns;
      }

      async function triggerTextBrigade() {
        if (!requireAdmin()) return;
        const msg = document.getElementById("brigade-message").value.trim();
        if (!msg) {
          showToast("Type a broadcast message first.", "warning");
          return;
        }
        if (learners.length === 0) {
          showToast("There are no learners registered yet.", "warning");
          return;
        }

        if (
          !confirm(
            `Are you sure you want to send this broadcast to ALL ${learners.length} registered parent numbers?`,
          )
        )
          return;

        const progressContainer = document.getElementById(
          "brigade-progress-container",
        );
        const progressTrack = document.getElementById("brigade-progress-track");
        const progressBar = document.getElementById("brigade-progress-bar");
        const progressText = document.getElementById("brigade-progress-text");
        const broadcastButton = document.getElementById("btn-trigger-brigade");

        progressContainer.classList.remove("hidden");
        progressTrack.setAttribute("aria-valuenow", "0");
        broadcastButton.disabled = true;
        broadcastButton.setAttribute("aria-busy", "true");
        broadcastButton.textContent = "Sending messages…";

        let sent = 0;
        let queued = 0;
        let failed = 0;
        progressBar.style.width = "0%";
        progressBar.setAttribute("aria-valuenow", "0");
        try {
          for (let i = 0; i < learners.length; i++) {
            const result = await dispatchSMS(learners[i].phone, msg, { notify: false });
            if (result.status === "sent") sent++;
            else if (result.status === "queued") queued++;
            else failed++;

            const pct = Math.round(((i + 1) / learners.length) * 100);
            progressBar.style.width = pct + "%";
            progressTrack.setAttribute("aria-valuenow", String(pct));
            progressText.innerText = `${i + 1} / ${learners.length}`;
          }

          if (failed || queued) {
            showToast(`Broadcast finished: ${sent} sent, ${queued} queued, ${failed} failed.`, "warning", 6000);
          } else {
            showToast(`Broadcast sent to all ${sent} recipients.`, "success");
          }
        } finally {
          broadcastButton.disabled = false;
          broadcastButton.removeAttribute("aria-busy");
          broadcastButton.textContent = "Send Broadcast";
          setTimeout(() => progressContainer.classList.add("hidden"), 3000);
        }
      }

      function renderLogsTable() {
        const tbody = document.getElementById("logs-table-body");
        const query = document
          .getElementById("search-logs")
          .value.toLowerCase();
        const selectedDate = document.getElementById("filter-log-date").value;
        const classFilter = document.getElementById("filter-log-class");
        const selectedClass = classFilter.value;
        const classNames = [
          ...new Set(
            [...learners, ...logs]
              .map((entry) => entry.className || "Unassigned")
              .filter(Boolean),
          ),
        ].sort((a, b) => a.localeCompare(b));
        classFilter.innerHTML =
          '<option value="">All classes</option>' +
          classNames
            .map(
              (className) =>
                `<option value="${escapeHTML(className)}">${escapeHTML(className)}</option>`,
            )
            .join("");
        if (classNames.includes(selectedClass)) {
          classFilter.value = selectedClass;
        }

        const reportDate = selectedDate || getLocalDateKey(new Date());
        const reportLearners = learners
          .filter(
            (learner) =>
              !selectedClass ||
              (learner.className || "Unassigned") === selectedClass,
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        const absenceSelect = document.getElementById("absence-learner");
        const previousLearner = absenceSelect.value;
        absenceSelect.innerHTML =
          '<option value="">Select a learner</option>' +
          reportLearners
            .map(
              (learner) =>
                `<option value="${escapeHTML(learner.lrn)}">${escapeHTML(learner.name)} — ${escapeHTML(learner.className || "Unassigned")}</option>`,
            )
            .join("");
        if (reportLearners.some((learner) => learner.lrn === previousLearner)) {
          absenceSelect.value = previousLearner;
        }
        renderAttendanceSummary(reportDate, selectedClass, reportLearners);

        const filtered = logs.filter((log) => {
          const matchesQuery =
            String(log.name || "").toLowerCase().includes(query) ||
            String(log.lrn || "").toLowerCase().includes(query) ||
            String(log.date || "").toLowerCase().includes(query) ||
            String(log.mode || "").toLowerCase().includes(query) ||
            String(log.className || "Unassigned").toLowerCase().includes(query);
          const matchesDate =
            !selectedDate || getLogDateKey(log) === selectedDate;
          const matchesClass =
            !selectedClass ||
            (log.className || "Unassigned") === selectedClass;
          return matchesQuery && matchesDate && matchesClass;
        });

        if (filtered.length === 0) {
          tbody.innerHTML = `<tr><td colspan="8" class="p-4 text-center text-gray-400">No attendance logs match these filters.</td></tr>`;
          renderRecentScansUI();
          return;
        }

        tbody.innerHTML = filtered
          .map(
            (l) => `
                <tr class="hover:bg-slate-50">
                    <td class="p-2.5 font-mono text-xs">${l.date} ${l.time}</td>
                    <td class="p-2.5 font-mono font-bold">${l.lrn}</td>
                    <td class="p-2.5">${l.name}</td>
                    <td class="p-2.5">${escapeHTML(l.className || "Unassigned")}</td>
                    <td class="p-2.5"><span class="px-2 py-0.5 text-xs rounded font-bold ${l.mode === "Time IN" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}">${l.mode}</span></td>
                    <td class="p-2.5 font-mono text-xs">${l.phone}</td>
                    <td class="p-2.5 text-xs text-gray-500">${l.smsStatus}</td>
                    <td class="p-2.5 text-center">
                        <button onclick="deleteLog(${l.id})" class="text-red-600 hover:text-red-800 text-xs font-bold">Delete</button>
                    </td>
                </tr>
            `,
          )
          .join("");

        renderRecentScansUI();
      }

      function renderAttendanceSummary(reportDate, selectedClass, roster) {
        const rosterIds = new Set(roster.map((learner) => learner.lrn));
        const period = document.getElementById("report-period")?.value || "day";
        const selected = new Date(`${reportDate}T00:00:00`);
        const rangeStart = new Date(selected);
        if (period === "week") rangeStart.setDate(selected.getDate() - 6);
        if (period === "month") rangeStart.setDate(1);
        const startKey = getLocalDateKey(rangeStart);
        const endKey = getLocalDateKey(selected);
        const dateLogs = logs.filter(
          (log) =>
            getLogDateKey(log) >= startKey &&
            getLogDateKey(log) <= endKey &&
            rosterIds.has(log.lrn),
        );
        const learnersWithCheckIn = new Set(
          dateLogs
            .filter((log) => log.mode === "Time IN")
            .map((log) => log.lrn),
        );
        const checkInDays = new Set(
          dateLogs
            .filter((log) => log.mode === "Time IN")
            .map((log) => `${log.lrn}|${getLogDateKey(log)}`),
        );
        const learnersWithCheckOut = new Set(
          dateLogs
            .filter((log) => log.mode === "Time OUT")
            .map((log) => log.lrn),
        );
        const cutoffValue = document.getElementById("late-cutoff").value;
        const cutoffMatch = cutoffValue.match(/^(\d{2}):(\d{2})$/);
        const lateCutoffMinutes = cutoffMatch
          ? Number(cutoffMatch[1]) * 60 + Number(cutoffMatch[2])
          : 8 * 60;
        const lateLearners = new Set(
          dateLogs
            .filter(
              (log) =>
                log.mode === "Time IN" &&
                getLogTimeMinutes(log) > lateCutoffMinutes,
            )
            .map((log) => log.lrn),
        );

        document.getElementById("report-present").innerText =
          learnersWithCheckIn.size;
        document.getElementById("report-absent").innerText = Math.max(
          0,
          roster.length - learnersWithCheckIn.size,
        );
        document.getElementById("report-late").innerText = lateLearners.size;
        document.getElementById("report-checked-out").innerText =
          learnersWithCheckOut.size;
        const periodDays = period === "day"
          ? 1
          : period === "week"
            ? 7
            : new Date(selected.getFullYear(), selected.getMonth() + 1, 0).getDate();
        const expectedCheckIns = Math.max(1, roster.length * periodDays);
        const attendanceRate = Math.min(
          100,
          Math.round((checkInDays.size / expectedCheckIns) * 100),
        );
        document.getElementById("report-rate").innerText = `${attendanceRate}%`;
        document.getElementById("report-roster").innerText = roster.length;

        const readableDate = new Date(`${reportDate}T00:00:00`).toLocaleDateString();
        document.getElementById("report-scope").innerText =
          `Daily summary for ${readableDate} · ${selectedClass || "All classes"} · Late after ${cutoffValue || "08:00"}`;
      }

      function markLearnerAbsent() {
        if (!requireAdmin()) return;
        const learnerId = document.getElementById("absence-learner").value;
        const reportDate = document.getElementById("filter-log-date").value;
        if (!learnerId) {
          alert("Select a learner to mark absent.");
          return;
        }
        if (!reportDate) {
          alert("Select the date for this absence.");
          return;
        }

        const learner = learners.find((entry) => entry.lrn === learnerId);
        if (!learner) {
          alert("The selected learner is no longer in the directory.");
          return;
        }

        const existingRecord = logs.find(
          (log) =>
            log.lrn === learner.lrn &&
            getLogDateKey(log) === reportDate &&
            (log.mode === "Time IN" ||
              log.mode === "Time OUT" ||
              log.mode === "Absent"),
        );
        if (existingRecord) {
          const status =
            existingRecord.mode === "Absent"
              ? "already marked absent"
              : `already has a ${existingRecord.mode} record`;
          alert(`${learner.name} ${status} for this date.`);
          return;
        }

        if (
          !confirm(
            `Mark ${learner.name} absent on ${new Date(`${reportDate}T00:00:00`).toLocaleDateString()}?`,
          )
        ) {
          return;
        }

        logs.unshift({
          id: Date.now() + Math.floor(Math.random() * 1000),
          date: new Date(`${reportDate}T00:00:00`).toLocaleDateString(),
          dateKey: reportDate,
          timestamp: `${reportDate}T00:00:00`,
          time: "—",
          lrn: learner.lrn,
          name: learner.name,
          parentName: learner.parentName,
          phone: learner.phone,
          className: learner.className || "Unassigned",
          mode: "Absent",
          smsStatus: "Not sent",
        });
        localStorage.setItem("sys_attendance_logs", JSON.stringify(logs));
        renderLogsTable();
        alert(`${learner.name} was marked absent.`);
      }

      function deleteLog(id) {
        if (!requireAdmin()) return;
        logs = logs.filter((l) => l.id !== id);
        localStorage.setItem("sys_attendance_logs", JSON.stringify(logs));
        recordAudit("Deleted attendance log", String(id));
        renderLogsTable();
      }

      function clearAllLogs() {
        if (!requireAdmin()) return;
        if (
          confirm(
            "Are you sure you want to permanently clear all attendance logs history?",
          )
        ) {
          logs = [];
          localStorage.setItem("sys_attendance_logs", JSON.stringify(logs));
          recordAudit("Cleared attendance logs");
          renderLogsTable();
        }
      }

      function exportLogsCSV() {
        if (!requireAdmin()) return;
        const reportDate = document.getElementById("filter-log-date").value;
        if (!reportDate) {
          alert("Select a report date before exporting.");
          return;
        }
        const selectedClass = document.getElementById("filter-log-class").value;
        const reportLearners = learners
          .filter(
            (learner) =>
              !selectedClass ||
              (learner.className || "Unassigned") === selectedClass,
          )
          .sort((a, b) => a.name.localeCompare(b.name));
        if (reportLearners.length === 0) {
          alert("There are no learners in the selected class to export.");
          return;
        }

        const cutoffMatch = document
          .getElementById("late-cutoff")
          .value.match(/^(\d{2}):(\d{2})$/);
        const lateCutoffMinutes = cutoffMatch
          ? Number(cutoffMatch[1]) * 60 + Number(cutoffMatch[2])
          : 8 * 60;
        const csvRows = [
          [
            "Date",
            "Class / Section",
            "LRN",
            "Learner Name",
            "Status",
            "Time IN",
            "Time OUT",
            "Manually Marked Absent",
            "Parent Name",
            "Phone",
            "SMS Status",
          ],
        ];

        for (const learner of reportLearners) {
          const learnerLogs = logs.filter(
            (log) =>
              log.lrn === learner.lrn &&
              getLogDateKey(log) === reportDate,
          );
          const timeIn = learnerLogs.find((log) => log.mode === "Time IN");
          const timeOut = learnerLogs.find((log) => log.mode === "Time OUT");
          const manualAbsence = learnerLogs.some(
            (log) => log.mode === "Absent",
          );
          const isLate =
            timeIn && getLogTimeMinutes(timeIn) > lateCutoffMinutes;
          const status = timeIn
            ? isLate
              ? "Late"
              : "Present"
            : manualAbsence
              ? "Absent (marked)"
              : "Absent (no check-in)";
          const smsLog = timeIn || timeOut;
          csvRows.push([
            reportDate,
            learner.className || "Unassigned",
            learner.lrn,
            learner.name,
            status,
            timeIn?.time || "",
            timeOut?.time || "",
            manualAbsence ? "Yes" : "No",
            learner.parentName,
            learner.phone,
            smsLog?.smsStatus || "Not sent",
          ]);
        }

        const csv = csvRows
          .map((row) => row.map(escapeCSVField).join(","))
          .join("\r\n");
        const safeClassName = selectedClass
          ? `_${selectedClass.replace(/[^a-z0-9_-]+/gi, "_")}`
          : "_All_Classes";
        downloadCSV(
          `${csv}\r\n`,
          `Attendance_Report_${reportDate}${safeClassName}.csv`,
        );
      }

      function escapeCSVField(value) {
        return `"${String(value ?? "").replace(/"/g, '""')}"`;
      }

      function loadSettingsUI() {
        document.getElementById("template-timein").value =
          settings.timeInTemplate;
        document.getElementById("template-timeout").value =
          settings.timeOutTemplate;
        document.getElementById("sms-mode").value = settings.mode;
        document.getElementById("sms-webhook-url").value =
          settings.webhookUrl || "http://localhost:3000/api/sms/send";
        document.getElementById("sms-client-token").value = settings.smsClientToken || "";
        document.getElementById("retention-days").value = settings.retentionDays || "";
        toggleSmsModeUI();
      }

      function toggleSmsModeUI() {
        const mode = document.getElementById("sms-mode").value;
        const box = document.getElementById("webhook-settings-box");
        if (mode === "webhook") box.classList.remove("hidden");
        else box.classList.add("hidden");
      }

      function saveSettings() {
        if (!requireAdmin()) return;
        settings.timeInTemplate = document
          .getElementById("template-timein")
          .value.trim();
        settings.timeOutTemplate = document
          .getElementById("template-timeout")
          .value.trim();
        settings.mode = document.getElementById("sms-mode").value;
        settings.webhookUrl = document
          .getElementById("sms-webhook-url")
          .value.trim();
        settings.smsClientToken = document.getElementById("sms-client-token").value.trim();
        settings.retentionDays = Math.max(0, Number(document.getElementById("retention-days").value) || 0);

        localStorage.setItem("sys_settings", JSON.stringify(settings));
        recordAudit("Updated system settings");
        showToast("Settings saved successfully.", "success");
      }

      function downloadSystemBackup() {
        if (!requireAdmin()) return;
        const backup = {
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          learners,
          logs,
          settings,
          auditTrail,
          pendingSmsQueue,
        };
        downloadFile(JSON.stringify(backup, null, 2), `Attendance_Backup_${getLocalDateKey(new Date())}.json`, "application/json");
        recordAudit("Downloaded system backup");
        showToast("Backup downloaded.", "success");
      }

      function restoreSystemBackup(event) {
        if (!requireAdmin()) return;
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const backup = JSON.parse(reader.result);
            if (!Array.isArray(backup.learners) || !Array.isArray(backup.logs)) throw new Error("Invalid backup format");
            if (!confirm(`Restore ${backup.learners.length} learners and ${backup.logs.length} logs? Current browser data will be replaced.`)) return;
            learners = backup.learners.map((learner) => ({ ...learner, className: learner.className || "Unassigned", qrVersion: Number(learner.qrVersion) || 1 }));
            logs = backup.logs;
            settings = { ...settings, ...(backup.settings || {}) };
            auditTrail = Array.isArray(backup.auditTrail) ? backup.auditTrail : [];
            pendingSmsQueue = Array.isArray(backup.pendingSmsQueue) ? backup.pendingSmsQueue : [];
            localStorage.setItem("sys_learners", JSON.stringify(learners));
            localStorage.setItem("sys_attendance_logs", JSON.stringify(logs));
            localStorage.setItem("sys_settings", JSON.stringify(settings));
            localStorage.setItem("sys_audit_trail", JSON.stringify(auditTrail));
            persistPendingSms();
            loadSettingsUI();
            renderLearnersTable();
            renderLogsTable();
            updateBrigadeCount();
            recordAudit("Restored system backup", file.name);
            showToast("Backup restored successfully.", "success");
          } catch (error) {
            showToast("Unable to restore: invalid backup file.", "error");
          } finally {
            event.target.value = "";
          }
        };
        reader.readAsText(file);
      }

      function clearOldLogs() {
        if (!requireAdmin()) return;
        const days = Number(settings.retentionDays || document.getElementById("retention-days").value) || 0;
        if (!days) {
          showToast("Set a retention period first (0 keeps all logs).", "warning");
          return;
        }
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const before = logs.length;
        logs = logs.filter((log) => getLogDateKey(log) >= getLocalDateKey(cutoff));
        localStorage.setItem("sys_attendance_logs", JSON.stringify(logs));
        recordAudit("Applied log retention", `Removed ${before - logs.length} logs`);
        renderLogsTable();
        showToast(`Removed ${before - logs.length} old log${before - logs.length === 1 ? "" : "s"}.`, "success");
      }

      function downloadFile(content, filename, type) {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(new Blob([content], { type }));
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(link.href);
      }

      function downloadCSV(csvContent, filename) {
        const blob = new Blob([csvContent], {
          type: "text/csv;charset=utf-8;",
        });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.setAttribute("download", filename);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      }
    
