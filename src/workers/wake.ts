/**
 * Worker'ni navbatga yangi job qo'shilishi bilan uyg'otish.
 *
 * Worker bo'sh navbatda WORKER_POLL_INTERVAL_MS (3 s) uxlaydi — yangi havola
 * o'rtacha 1.5 s behuda kutib turardi. Bot/webhook job qo'shgach `wakeWorkers()`
 * ni chaqiradi va uxlab yotgan worker darhol navbatni tekshiradi.
 *
 * Faqat shu jarayon ichida ishlaydi: alohida worker jarayoni (npm run worker)
 * odatdagidek interval bo'yicha tekshiradi.
 *
 * Importsiz modul — bot ↔ worker orasida aylanma import bo'lmasin.
 */
const sleepers = new Set<() => void>();

/** `ms` kutadi yoki `wakeWorkers()` chaqirilsa — darhol qaytadi. */
export function idle(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      sleepers.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    sleepers.add(done);
  });
}

export function wakeWorkers(): void {
  for (const wake of [...sleepers]) wake();
}
