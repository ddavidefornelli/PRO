export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function persistence() {
  const values = new Map(), locks = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
  const lock = async (name, work) => {
    const previous = locks.get(name) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    locks.set(name, next);
    try { return await next; } finally { if (locks.get(name) === next) locks.delete(name); }
  };
  return { storage, lock, values };
}
export function dashboard(at = Math.floor(Date.now() / 1000)) {
  const today = new Date(at * 1000).toISOString().slice(0, 10);
  return { revision: 0, today, tomorrow: new Date(at * 1000 + 86400000).toISOString().slice(0, 10), todayTasks: [], tomorrowTasks: [], activeTask: null, canPlanTomorrow: false, completions: [], serverNow: at };
}
export const offline = async () => { throw { code: "network", message: "Offline fixture" }; };
