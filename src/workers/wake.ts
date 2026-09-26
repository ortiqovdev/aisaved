/**
 * Worker'ni navbatga yangi job qo'shilishi bilan uyg'otish.
 *
 * Worker bo'sh navbatda uxlaydi — yangi havola o'rtacha 1.5 s behuda kutib
 * turardi. Bot/webhook job qo'shgach `wakeWorkers()` ni chaqiradi va uxlab
 * yotgan BITTA worker darhol navbatni tekshiradi. U job olsa, keyingisini
 * uyg'otadi (zanjir) — ketma-ket kelgan so'rovlar ham parallel ishlanadi,
 * lekin bitta job uchun 8 ta slot bazaga birdaniga murojaat qilmaydi.
 *
 * Faqat shu jarayon ichida ishlaydi: alohida worker jarayoni (npm run worker)
 * interval bo'yicha tekshiradi.
 *
 * Importsiz modul — bot ↔ worker orasida aylanma import bo'lmasin.
 */
const sleepers = new Set<() => void>();

/** `ms` kutadi yoki uyg'otilsa — darhol qaytadi. */
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

/** Uxlab yotgan bitta worker'ni uyg'otadi (hammasi band bo'lsa — hech narsa qilmaydi). */
export function wakeWorkers(): void {
  const first = sleepers.values().next();
  if (!first.done) first.value();
}
