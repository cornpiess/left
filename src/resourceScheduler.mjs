// One bounded queue for native metadata/IO. Rendering and playback stay native.
export function createResourceScheduler({ concurrency = 3 } = {}) {
  const tasks = new Map();
  const waiting = [];
  let active = 0, activeBackground = 0, interactive = false, suspended = false;
  function pump() {
    waiting.sort((a,b) => a.priority-b.priority);
    while (active < concurrency && !suspended) {
      const index = waiting.findIndex(task => task.priority === 0 || (!interactive && activeBackground < Math.max(1, concurrency - 1)));
      if (index < 0) break;
      const task = waiting.splice(index,1)[0];
      active++;
      const background = task.priority > 0;
      if (background) activeBackground++;
      Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => {
        active--; if (background) activeBackground--; tasks.delete(task.key); pump();
      });
    }
  }
  return {
    run(key, priority, work) {
      if (tasks.has(key)) {
      const task = tasks.get(key);
      task.priority = Math.min(task.priority, priority);
      pump();
      return task.promise;
    }
      const task = { key, priority, work };
      task.promise = new Promise((resolve,reject) => Object.assign(task,{resolve,reject}));
      tasks.set(key,task); waiting.push(task); pump();
      return task.promise;
    },
    setInteractive(value) { interactive = value; pump(); },
    setSuspended(value) { suspended = value; pump(); },
    cancelQueued(predicate) {
      for (let i=waiting.length-1;i>=0;i--) {
        if (predicate(waiting[i].key)) {
          const [task] = waiting.splice(i,1); tasks.delete(task.key); task.resolve(null);
        }
      }
    },
    get pending() { return waiting.length; },
  };
}
