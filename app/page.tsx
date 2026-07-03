"use client";

import { useEffect, useRef, useState } from "react";
import { initializeApp } from "firebase/app";
import { getDatabase, onValue, ref, update } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyCDHgJiryuoxQUIS6lZNB0nwLc_yqs0gb4",
  authDomain: "pranvayu-4658d.firebaseapp.com",
  databaseURL:
    "https://pranvayu-4658d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "pranvayu-4658d",
  storageBucket: "pranvayu-4658d.firebasestorage.app",
  messagingSenderId: "722989978618",
  appId: "1:722989978618:web:7c51ffe9a816a0e2a80a43",
  measurementId: "G-4ERHGM9KN4",
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

type Mode = "manual" | "schedule";

type StatusSnapshot = {
  temperature?: number;
  motorOn?: boolean;
  rssi?: number;
  clockSynced?: boolean;
  lastSeen?: number;
};

type ControlSnapshot = {
  mode?: Mode | string;
  manualOn?: boolean;
  schedule?: {
    start?: string;
    end?: string;
  };
  alarmArmed?: boolean;
};

type SecuritySnapshot = {
  alert?: boolean;
  lastAlertAt?: number;
};

function formatKathmanduTime(value: number) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kathmandu",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function isTimeInput(value: string) {
  return /^\d{2}:\d{2}$/.test(value);
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("manual");
  const [manualOn, setManualOn] = useState(false);
  const [scheduleStart, setScheduleStart] = useState("18:00");
  const [scheduleEnd, setScheduleEnd] = useState("22:00");
  const [alarmArmed, setAlarmArmed] = useState(false);

  const [temperature, setTemperature] = useState<number | null>(null);
  const [motorOn, setMotorOn] = useState(false);
  const [rssi, setRssi] = useState<number | null>(null);
  const [clockSynced, setClockSynced] = useState(true);
  const [lastSeen, setLastSeen] = useState(0);
  const [alertActive, setAlertActive] = useState(false);
  const [lastAlertAt, setLastAlertAt] = useState(0);

  const [clockTick, setClockTick] = useState(() => Date.now());
  const [pendingTarget, setPendingTarget] = useState<boolean | null>(null);
  const [pendingMessage, setPendingMessage] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);

  const pendingTargetRef = useRef<boolean | null>(null);
  const pendingSinceRef = useRef(0);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick(Date.now()), 3000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const statusUnsub = onValue(ref(db, "aerator/status"), (snapshot) => {
      const status = (snapshot.val() ?? {}) as StatusSnapshot;

      setTemperature(
        typeof status.temperature === "number" ? status.temperature : null,
      );
      setMotorOn(Boolean(status.motorOn));
      setRssi(typeof status.rssi === "number" ? status.rssi : null);
      setClockSynced(status.clockSynced !== false);
      setLastSeen(typeof status.lastSeen === "number" ? status.lastSeen : 0);

      if (
        pendingTargetRef.current !== null &&
        Boolean(status.motorOn) === pendingTargetRef.current
      ) {
        pendingTargetRef.current = null;
        setPendingTarget(null);
        setPendingMessage("");
      }
    });

    const controlUnsub = onValue(ref(db, "aerator/control"), (snapshot) => {
      const control = (snapshot.val() ?? {}) as ControlSnapshot;

      setMode(control.mode === "schedule" ? "schedule" : "manual");
      setManualOn(Boolean(control.manualOn));
      setScheduleStart(
        typeof control.schedule?.start === "string"
          ? control.schedule.start
          : "18:00",
      );
      setScheduleEnd(
        typeof control.schedule?.end === "string"
          ? control.schedule.end
          : "22:00",
      );
      setAlarmArmed(Boolean(control.alarmArmed));
    });

    const securityUnsub = onValue(ref(db, "aerator/security"), (snapshot) => {
      const security = (snapshot.val() ?? {}) as SecuritySnapshot;

      setAlertActive(Boolean(security.alert));
      setLastAlertAt(
        typeof security.lastAlertAt === "number" ? security.lastAlertAt : 0,
      );
    });

    return () => {
      statusUnsub();
      controlUnsub();
      securityUnsub();
    };
  }, []);

  useEffect(() => {
    if (pendingTargetRef.current === null) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      if (
        pendingTargetRef.current !== null &&
        Date.now() - pendingSinceRef.current > 6000
      ) {
        setPendingMessage("Device not responding - check that it is online.");
        pendingTargetRef.current = null;
        setPendingTarget(null);
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [pendingTarget]);

  const online = lastSeen > 0 && clockTick - lastSeen < 45000;
  const pumpNeedsConfirmation = pendingTarget !== null;

  async function handleManualToggle(nextValue: boolean) {
    pendingTargetRef.current = nextValue;
    pendingSinceRef.current = Date.now();
    setPendingTarget(nextValue);
    setPendingMessage("");
    setManualOn(nextValue);
    setMode("manual");

    await update(ref(db, "aerator/control"), {
      mode: "manual",
      manualOn: nextValue,
    });
  }

  async function handleModeChange(nextMode: Mode) {
    setMode(nextMode);
    await update(ref(db, "aerator/control"), { mode: nextMode });
  }

  async function handleScheduleSave() {
    if (!isTimeInput(scheduleStart) || !isTimeInput(scheduleEnd)) {
      setPendingMessage("Pick both schedule times in HH:MM format.");
      return;
    }

    setSavingSchedule(true);
    setPendingMessage("");

    try {
      await update(ref(db, "aerator/control"), {
        mode: "schedule",
        schedule: {
          start: scheduleStart,
          end: scheduleEnd,
        },
      });
      setMode("schedule");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function handleAlarmToggle(nextValue: boolean) {
    setAlarmArmed(nextValue);
    await update(ref(db, "aerator/control"), {
      alarmArmed: nextValue,
    });
  }

  return (
    <main className="min-h-dvh overflow-x-hidden overflow-y-auto bg-[radial-gradient(circle_at_top,#f6fff8_0%,#eef9f1_34%,#ffffff_100%)] px-4 py-4 text-slate-900 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100dvh-2rem)] w-full max-w-7xl flex-col gap-4">
        <div className="text-lg font-bold text-slate-900 flex justify-center">Budhi Ganga GauPalika</div>
        {alertActive ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 shadow-sm">
            <span className="font-semibold uppercase tracking-[0.18em]">
              Alarm
            </span>
            <span className="ml-3">
              Theft alert active
              {lastAlertAt ? ` at ${formatKathmanduTime(lastAlertAt)} NPT` : ""}
              .
            </span>
          </div>
        ) : null}

        <section className="grid flex-1 gap-4 lg:grid-cols-[1.15fr_0.85fr] lg:items-start">
          <div className="flex min-h-0 flex-col justify-between rounded-[34px] border border-emerald-100 bg-white/90 p-4 shadow-[0_24px_80px_rgba(12,76,36,0.10)] backdrop-blur sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"></div>

            <div className="mt-6 flex flex-1 items-center justify-center">
              <div
                className={`relative flex aspect-square w-full max-w-72 items-center justify-center rounded-full border bg-[radial-gradient(circle_at_top,#ffffff_0%,#f3fbf4_56%,#e9f7ed_100%)] sm:max-w-88 lg:max-w-104 ${motorOn ? "border-emerald-300 shadow-[0_0_0_1px_rgba(34,197,94,0.12),0_24px_80px_rgba(34,197,94,0.20)]" : "border-emerald-100"} ${pumpNeedsConfirmation ? "ring-2 ring-emerald-300/70" : ""}`}
              >
                <div className="absolute inset-5 rounded-full border border-emerald-100" />
                <div className="absolute inset-10 rounded-full border border-emerald-100/80" />
                <div className="absolute inset-16 rounded-full border border-emerald-50 bg-white/60" />
                <div className="text-center">
                  <p
                    className={`text-[0.68rem] font-semibold uppercase tracking-[0.5em] ${motorOn ? "text-emerald-600" : "text-slate-400"}`}
                  >
                    {pumpNeedsConfirmation ? "Waiting" : "Actual state"}
                  </p>
                  <div
                    className={`mt-3 text-4xl font-semibold tracking-[0.26em] sm:text-6xl ${motorOn ? "text-emerald-600" : "text-slate-700"}`}
                  >
                    {motorOn ? "ON" : "OFF"}
                  </div>
                </div>
              </div>
            </div>
            <div>
              <p className="text-xl text-slate-500 flex justify-center mt-1.5">
                {temperature === null ? "--" : temperature.toFixed(1)}&deg;C
                water temperature
              </p>
            </div>

            {pendingMessage ? (
              <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                {pendingMessage}
              </p>
            ) : null}
          </div>

          <aside className="flex min-h-0 flex-col gap-4 rounded-[34px] border border-emerald-100 bg-white/90 p-4 shadow-[0_24px_80px_rgba(12,76,36,0.08)] backdrop-blur sm:p-5">
            <div>
              <p className="text-[0.68rem] font-semibold uppercase tracking-[0.34em] text-emerald-600">
                Controls
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-3xl border border-emerald-100 bg-emerald-50/60 p-2">
                <button
                  type="button"
                  onClick={() => void handleModeChange("manual")}
                  className={`rounded-[18px] px-4 py-3 text-sm font-medium transition ${mode === "manual" ? "bg-emerald-500 text-white shadow-lg shadow-emerald-500/20" : "text-slate-600 hover:bg-white"}`}
                >
                  Manual
                </button>
                <button
                  type="button"
                  onClick={() => void handleModeChange("schedule")}
                  className={`rounded-[18px] px-4 py-3 text-sm font-medium transition ${mode === "schedule" ? "bg-emerald-100 text-emerald-800 shadow-sm" : "text-slate-600 hover:bg-white"}`}
                >
                  Schedule
                </button>
              </div>
            </div>

            <div
              className={`rounded-[28px] border border-emerald-100 bg-white px-4 py-4 ${mode !== "manual" ? "opacity-70" : ""}`}
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">
                    Manual switch
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Writes{" "}
                    <span className="font-medium text-emerald-700">
                      manualOn
                    </span>{" "}
                    and keeps mode manual.
                  </p>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={manualOn}
                    onChange={(event) =>
                      void handleManualToggle(event.target.checked)
                    }
                    disabled={mode !== "manual"}
                    className="peer sr-only"
                  />
                  <span className="h-8 w-14 rounded-full border border-emerald-200 bg-emerald-50 transition peer-checked:bg-emerald-500 peer-disabled:cursor-not-allowed peer-disabled:opacity-40" />
                  <span className="absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow-md transition peer-checked:translate-x-6 peer-checked:bg-white" />
                </label>
              </div>
            </div>

            <div className="grid gap-4 rounded-[28px] border border-emerald-100 bg-white px-4 py-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700">
                  Start
                </span>
                <input
                  type="time"
                  value={scheduleStart}
                  onChange={(event) => setScheduleStart(event.target.value)}
                  className="w-full rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 text-slate-900 outline-none transition focus:border-emerald-400"
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.22em] text-emerald-700">
                  End
                </span>
                <input
                  type="time"
                  value={scheduleEnd}
                  onChange={(event) => setScheduleEnd(event.target.value)}
                  className="w-full rounded-2xl border border-emerald-100 bg-emerald-50/70 px-4 py-3 text-slate-900 outline-none transition focus:border-emerald-400"
                />
              </label>
              <button
                type="button"
                onClick={() => void handleScheduleSave()}
                disabled={savingSchedule}
                className="inline-flex items-center justify-center rounded-2xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(34,197,94,0.22)] transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60 sm:col-span-2"
              >
                {savingSchedule ? "Saving schedule..." : "Save schedule"}
              </button>
            </div>

            <div className="rounded-[28px] border border-emerald-100 bg-white px-4 py-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Alarm</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Theft protection from{" "}
                    <span className="font-medium text-emerald-700">
                      /aerator/control/alarmArmed
                    </span>
                    .
                  </p>
                </div>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={alarmArmed}
                    onChange={(event) =>
                      void handleAlarmToggle(event.target.checked)
                    }
                    className="peer sr-only"
                  />
                  <span className="h-8 w-14 rounded-full border border-emerald-200 bg-emerald-50 transition peer-checked:bg-emerald-500" />
                  <span className="absolute left-1 top-1 h-6 w-6 rounded-full bg-white shadow-md transition peer-checked:translate-x-6" />
                </label>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
