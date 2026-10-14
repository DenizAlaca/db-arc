const TR_MAP = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };

export function fold(s) {
  return String(s)
    .replace(/[çğıİöşüâîû]/gi, (c) => TR_MAP[c] ?? TR_MAP[c.toLowerCase()] ?? c)
    .toLowerCase();
}

export function splitIdent(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9çğıİöşüÇĞÖŞÜ]+/)
    .filter(Boolean)
    .map(fold);
}

const EN_SUFFIX = [
  ['ies', 'y'], ['sses', 'ss'], ['xes', 'x'], ['ches', 'ch'], ['shes', 'sh'], ['tuses', 'tus'], ['buses', 'bus'],
  ['ings', ''], ['ing', ''], ['ed', ''], ['s', ''],
];
const TR_SUFFIX = [
  'lerinin', 'larinin', 'lerini', 'larini', 'lerine', 'larina', 'lerinde', 'larinda', 'lerinden', 'larindan',
  'leri', 'lari', 'ler', 'lar', 'nin', 'nun', 'inin', 'unun', 'ini', 'unu', 'ine', 'una', 'inde', 'unda',
  'den', 'dan', 'ten', 'tan', 'de', 'da', 'te', 'ta', 'yi', 'yu', 'ye', 'ya', 'si', 'su', 'in', 'un',
];

const IRREGULAR = { buses: 'bus', people: 'person', children: 'child', men: 'man', women: 'woman', indices: 'index', analyses: 'analysis', criteria: 'criterion', cancelled: 'cancel', canceled: 'cancel', cancelling: 'cancel', labelled: 'label', travelled: 'travel', modelled: 'model' };

export function stem(w) {
  w = fold(w);
  if (IRREGULAR[w]) return IRREGULAR[w];
  if (w.length <= 3) return w;
  for (const suf of TR_SUFFIX) {
    if (w.length - suf.length >= 3 && w.endsWith(suf) && TR_ROOTS.has(w.slice(0, -suf.length))) return w.slice(0, -suf.length);
  }
  for (const [suf, rep] of EN_SUFFIX) {
    const min = suf === 'ing' || suf === 'ings' || suf === 'ed' ? 4 : 3;
    if (w.length - suf.length >= min && w.endsWith(suf)) {
      if (suf === 's' && (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is'))) continue;
      let out = w.slice(0, -suf.length) + rep;
      if ((suf === 'ed' || suf === 'ing') && /([bdgmnprt])\1$/.test(out)) out = out.slice(0, -1);
      return out;
    }
  }
  return w;
}

export const SYNONYMS = {
  kullanici: ['user', 'account', 'member'], uye: ['member', 'user'], hesap: ['account'],
  musteri: ['customer', 'client'], cari: ['customer', 'account'], siparis: ['order'], urun: ['product', 'item'],
  kalem: ['item', 'line'], sepet: ['cart', 'basket'], kategori: ['category'], odeme: ['payment', 'pay'],
  fatura: ['invoice', 'bill'], fis: ['receipt', 'check'], adres: ['address'], teslimat: ['delivery', 'shipment'],
  kargo: ['shipment', 'shipping', 'cargo'],
  magaza: ['store', 'shop'], isletme: ['business', 'company'], firma: ['company', 'firm'],
  sirket: ['company'], tedarikci: ['supplier', 'vendor'], stok: ['stock', 'inventory'], depo: ['warehouse'],
  fiyat: ['price'], indirim: ['discount'], kupon: ['coupon'], kampanya: ['campaign', 'promotion'],
  yorum: ['comment', 'review'], degerlendirme: ['review', 'rating'], puan: ['point', 'rating', 'score'],
  sadakat: ['loyalty'], rol: ['role'], yetki: ['permission', 'role'], izin: ['permission', 'leave'],
  oturum: ['session'], token: ['token'], sifre: ['password'], bildirim: ['notification'], mesaj: ['message'],
  sms: ['sm', 'sms'], eposta: ['email', 'mail'], mail: ['mail', 'email'], log: ['log', 'audit'], kayit: ['record', 'log', 'registration'],
  denetim: ['audit'], gecmis: ['history'], durum: ['status', 'state'], tip: ['type'], tur: ['type', 'kind'],
  bilet: ['ticket'], sefer: ['trip', 'journey', 'schedule'], koltuk: ['seat'], otobus: ['bus', 'vehicle'],
  arac: ['vehicle', 'car'], guzergah: ['route'], rota: ['route'], durak: ['stop', 'station'], istasyon: ['station'],
  rezervasyon: ['reservation', 'booking'], randevu: ['appointment'],
 
  personel: ['staff', 'employee'], calisan: ['employee', 'staff'], vardiya: ['shift'], mesai: ['shift', 'attendance'],
  maas: ['salary', 'payroll'], devam: ['attendance'], kasa: ['cash', 'register'], para: ['money', 'cash'],
  islem: ['transaction'], hareket: ['movement', 'transaction'], bakiye: ['balance'], cuzdan: ['wallet'],
  abonelik: ['subscription'], plan: ['plan'], paket: ['package', 'plan'], yazici: ['printer'], cihaz: ['device'],
  terminal: ['terminal'], bolge: ['zone', 'region'], sehir: ['city'], ilce: ['district'], ulke: ['country'],
  konum: ['location'], resim: ['image', 'photo'], gorsel: ['image', 'media'], dosya: ['file', 'attachment'],
  belge: ['document'], vergi: ['tax'], ogrenci: ['student'], ders: ['course', 'lesson'],
  ogretmen: ['teacher', 'instructor'], sinav: ['exam'], not: ['note', 'grade'], hasta: ['patient'], doktor: ['doctor'],
  urunler: ['product'], iptal: ['cancel'], iade: ['refund', 'return'], cagri: ['call'], arama: ['call', 'search'],
  sablon: ['template'], secenek: ['option'], ayar: ['setting', 'config'], kural: ['rule'], hedef: ['target'],
  oyun: ['game'], skor: ['score'], oyuncu: ['player'], etiket: ['tag', 'label'], gonderi: ['post', 'shipment'],
  takip: ['follow', 'tracking'], begeni: ['like'], arkadas: ['friend'], grup: ['group'], kanal: ['channel'],
  gelir: ['revenue', 'income'], gider: ['expense'], ciro: ['revenue', 'sale'],
  sayim: ['count'], teslim: ['delivery', 'deliver'], rapor: ['report'], satis: ['sale', 'order'], alis: ['purchase'],
  satin: ['purchase'], tahsilat: ['payment', 'collection'], borc: ['debt', 'balance'], alacak: ['receivable', 'balance'],
  giris: ['login', 'entry'], cikis: ['logout', 'exit'], profil: ['profile'], ayarlar: ['setting'], dil: ['language', 'locale'],
  sunucu: ['server'], dugum: ['node'], proje: ['project'], gorev: ['task', 'job'], is: ['job', 'work'],
};

const TR_ROOTS = new Set(Object.keys(SYNONYMS));

const STOP = new Set(`
a an the and or of to in on at for from by with without is are was were be been this that these those it its as
do does did done can could should would will shall may might must not no yes all any some each every
get set add new list show make create update delete remove fix use using into about how what which where when why who
please want need i me my we our you your there here then than also just only more most less
bir ve veya ile icin bu su o da de mi mu ki ne neden nasil hangi nerede zaman gibi daha en cok az her hic
olan olarak olsun yap yapalim yapar yapmak ekle ekleyelim sil guncelle duzelt goster getir bul listele lazim istiyorum
var yok ama fakat ancak sonra once simdi tum butun icin uzerinde altinda kadar gore diye beni bana sana bizim
`.split(/\s+/).filter(Boolean));

export function promptTerms(text) {
  const raw = String(text).split(/[^A-Za-z0-9_çğıİöşüÇĞÖŞÜ]+/).filter(Boolean);
  const terms = new Map();
  const add = (t, w) => { if (t.length >= 2 && !STOP.has(t)) terms.set(t, Math.max(terms.get(t) ?? 0, w)); };
  for (const word of raw) {
    const parts = /[A-Z_]/.test(word.slice(1)) ? [word, ...splitIdent(word)] : [word];
    for (const p of parts) {
      const f = fold(p);
      if (STOP.has(f)) continue;
      const s = stem(f);
      add(s, 1);
      if (f !== s) add(f, 1);
      for (const key of [f, s, ...prefixRoots(f)]) {
        for (const syn of SYNONYMS[key] ?? []) add(stem(syn), 0.9);
      }
    }
  }
  return terms;
}

function prefixRoots(w) {
  const out = [];
  for (let n = Math.min(w.length, 14); n >= 3; n--) {
    const p = w.slice(0, n);
    if (TR_ROOTS.has(p)) { out.push(p); break; }
  }
  return out;
}

export function identTerms(name) {
  return splitIdent(name).map(stem).filter((t) => t.length >= 2);
}

export const estimateTokens = (s) => Math.ceil(String(s).length / 3.6);
