/**
 * How the code uses a role, so the settings screen does not promise what nothing does.
 * posting: posting code reads the mapping and writes to it.
 * default: only suggests or pre-fills an account in a picker.
 * manual:  usable through manual journals only; no code reads the mapping.
 * belum:   nothing reads it yet (registered for later; hidden behind a toggle in the UI).
 */
export type RoleUsage = 'posting' | 'default' | 'manual' | 'belum';

export const SYSTEM_ACCOUNT_ROLES = {
  CASH: {
    key: 'CASH',
    label: 'Kas & Bank',
    description: 'Akun kas dan bank untuk pembayaran masuk/keluar',
    multiAccount: true,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  AR: {
    key: 'AR',
    label: 'Piutang Usaha',
    description: 'Auto-debit saat faktur penjualan di-submit',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  AP: {
    key: 'AP',
    label: 'Hutang Usaha',
    description: 'Auto-credit saat faktur pembelian di-submit',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'LIABILITY' as const,
  },
  INVENTORY: {
    key: 'INVENTORY',
    label: 'Persediaan',
    description: 'Akun persediaan barang default',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  SALES: {
    key: 'SALES',
    label: 'Penjualan',
    description: 'Auto-credit pendapatan penjualan',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'REVENUE' as const,
  },
  SERVICE_REVENUE: {
    key: 'SERVICE_REVENUE',
    label: 'Pendapatan Jasa',
    description: 'Default akun pendapatan jasa',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'REVENUE' as const,
  },
  VENDOR_DEPOSIT: {
    key: 'VENDOR_DEPOSIT',
    label: 'Uang Muka Pembelian',
    description: 'Akun uang muka ke vendor/supplier',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  CUSTOMER_DEPOSIT: {
    key: 'CUSTOMER_DEPOSIT',
    label: 'Uang Muka Pelanggan',
    description: 'Akun uang muka dari pelanggan',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'LIABILITY' as const,
  },
  PROJECT_GUARANTEE: {
    key: 'PROJECT_GUARANTEE',
    label: 'Uang Jaminan Proyek',
    description: 'Setoran jaminan (tender/pelaksanaan) ke pemberi proyek',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  EMPLOYEE_ADVANCE: {
    key: 'EMPLOYEE_ADVANCE',
    label: 'Uang Muka Karyawan',
    description: 'Didebit saat Pengajuan Pembayaran jenis uang muka / perjalanan dinas dibayar',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  COGS: {
    key: 'COGS',
    label: 'Beban Pokok Penjualan',
    description: 'HPP - auto-debit saat penjualan barang',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },
  OPENING_EQUITY: {
    key: 'OPENING_EQUITY',
    label: 'Ekuitas Saldo Awal',
    description: 'Contra account untuk import/setup saldo awal',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EQUITY' as const,
  },
  RETAINED_EARNINGS: {
    key: 'RETAINED_EARNINGS',
    label: 'Laba Ditahan',
    description: 'Akun tutup buku akhir tahun fiskal',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EQUITY' as const,
  },
  CURRENT_PROFIT: {
    key: 'CURRENT_PROFIT',
    label: 'Laba Tahun Berjalan',
    description: 'Laba tahun berjalan (computed di neraca)',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EQUITY' as const,
  },

  // Pajak
  TAX_INPUT: {
    key: 'TAX_INPUT',
    label: 'PPN Masukan',
    description: 'PPN masukan dari pembelian barang/jasa (VAT Input)',
    multiAccount: false,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  TAX_OUTPUT: {
    key: 'TAX_OUTPUT',
    label: 'PPN Keluaran',
    description: 'PPN keluaran dari penjualan barang/jasa (VAT Output)',
    multiAccount: false,
    required: true,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'LIABILITY' as const,
  },
  INCOME_TAX_EXPENSE: {
    key: 'INCOME_TAX_EXPENSE',
    label: 'Beban Pajak Penghasilan',
    description: 'Beban pajak penghasilan badan (PPh Badan)',
    multiAccount: false,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Diskon & Retur
  SALES_DISCOUNT: {
    key: 'SALES_DISCOUNT',
    label: 'Diskon Penjualan',
    description: 'Contra revenue: potongan harga penjualan ke pelanggan',
    multiAccount: false,
    required: false,
    usage: 'belum' as RoleUsage,
    expectedRootType: 'REVENUE' as const,
  },
  SALES_RETURN: {
    key: 'SALES_RETURN',
    label: 'Retur Penjualan',
    description: 'Contra revenue: pengembalian barang dari pelanggan',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'REVENUE' as const,
  },

  // Pengiriman
  SHIPPING_EXPENSE: {
    key: 'SHIPPING_EXPENSE',
    label: 'Beban Pengiriman',
    description: 'Biaya ekspedisi/pengiriman barang ke pelanggan',
    multiAccount: false,
    required: false,
    usage: 'belum' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Aset Tetap & Depresiasi
  FIXED_ASSET: {
    key: 'FIXED_ASSET',
    label: 'Aset Tetap',
    description: 'Akun default untuk pencatatan pembelian aset tetap',
    multiAccount: true,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  ACCUM_DEPRECIATION: {
    key: 'ACCUM_DEPRECIATION',
    label: 'Akumulasi Penyusutan',
    description: 'Akun kontra aset untuk akumulasi penyusutan aset tetap',
    multiAccount: true,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  DEPRECIATION_EXPENSE: {
    key: 'DEPRECIATION_EXPENSE',
    label: 'Beban Penyusutan',
    description: 'Beban penyusutan aset tetap periodik',
    multiAccount: true,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Biaya Bank & Bunga
  BANK_CHARGE: {
    key: 'BANK_CHARGE',
    label: 'Beban Administrasi Bank',
    description: 'Biaya administrasi bank, buku cek, giro',
    multiAccount: false,
    required: false,
    usage: 'belum' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },
  INTEREST_EXPENSE: {
    key: 'INTEREST_EXPENSE',
    label: 'Beban Bunga',
    description: 'Beban bunga pinjaman bank/pihak ketiga',
    multiAccount: false,
    required: false,
    usage: 'belum' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },
  INTEREST_INCOME: {
    key: 'INTEREST_INCOME',
    label: 'Pendapatan Bunga',
    description: 'Pendapatan bunga deposito/tabungan bank',
    multiAccount: false,
    required: false,
    usage: 'belum' as RoleUsage,
    expectedRootType: 'REVENUE' as const,
  },

  // Selisih Kurs
  FX_GAIN_LOSS: {
    key: 'FX_GAIN_LOSS',
    label: 'Laba/Rugi Selisih Kurs',
    description: 'Dipakai lewat jurnal umum; tidak ada posting otomatis (pembukuan hanya rupiah)',
    multiAccount: false,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },
  FX_UNREALIZED: {
    key: 'FX_UNREALIZED',
    label: 'Laba/Rugi Kurs Belum Terealisasi',
    description: 'Dipakai lewat jurnal umum; revaluasi valas belum didukung (pembukuan hanya rupiah)',
    multiAccount: false,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Piutang Tak Tertagih
  BAD_DEBT_EXPENSE: {
    key: 'BAD_DEBT_EXPENSE',
    label: 'Beban Piutang Tak Tertagih',
    description: 'Beban penghapusan piutang yang tidak dapat ditagih',
    multiAccount: false,
    required: false,
    usage: 'belum' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },
  ALLOWANCE_DOUBTFUL: {
    key: 'ALLOWANCE_DOUBTFUL',
    label: 'Cadangan Kerugian Piutang',
    description: 'Contra asset: penyisihan piutang ragu-ragu',
    multiAccount: false,
    required: false,
    usage: 'belum' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },

  // Akrual & Dibayar Dimuka
  PREPAID_EXPENSE: {
    key: 'PREPAID_EXPENSE',
    label: 'Biaya Dibayar Dimuka',
    description: 'Aset lancar: biaya yang sudah dibayar tapi belum jatuh tempo',
    multiAccount: true,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'ASSET' as const,
  },
  ACCRUED_EXPENSE: {
    key: 'ACCRUED_EXPENSE',
    label: 'Hutang Beban Akrual',
    description: 'Kewajiban: beban yang sudah terjadi tapi belum dibayar',
    multiAccount: false,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'LIABILITY' as const,
  },

  // Ekuitas Tambahan
  OWNER_DRAWING: {
    key: 'OWNER_DRAWING',
    label: 'Prive / Penarikan Pemilik',
    description: 'Penarikan modal oleh pemilik/pemegang saham',
    multiAccount: false,
    required: false,
    usage: 'manual' as RoleUsage,
    expectedRootType: 'EQUITY' as const,
  },

  // Pendapatan & Beban Lain-lain
  OTHER_INCOME: {
    key: 'OTHER_INCOME',
    label: 'Pendapatan Lain-lain',
    description: 'Pendapatan di luar usaha utama (non-operating income)',
    multiAccount: false,
    required: false,
    usage: 'default' as RoleUsage,
    expectedRootType: 'REVENUE' as const,
  },
  OTHER_EXPENSE: {
    key: 'OTHER_EXPENSE',
    label: 'Beban Lain-lain',
    description: 'Beban di luar operasional utama (non-operating expense)',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Biaya Konversi Produksi
  PRODUCTION_CONVERSION: {
    key: 'PRODUCTION_CONVERSION',
    label: 'Biaya Konversi Produksi',
    description: 'Selisih nilai output vs input produksi (biaya konversi: listrik, tenaga kerja, overhead)',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Selisih Persediaan
  INVENTORY_VARIANCE: {
    key: 'INVENTORY_VARIANCE',
    label: 'Selisih Persediaan',
    description: 'Beban selisih stok opname (inventory variance expense)',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Pembulatan
  ROUNDING_ACCOUNT: {
    key: 'ROUNDING_ACCOUNT',
    label: 'Pembulatan / Selisih',
    description: 'Akun untuk pembulatan dan selisih kecil yang tidak material',
    multiAccount: false,
    required: false,
    // Manual journals only; the Inventory Variance guard (services/inventory/varianceAccount.ts)
    // reads it just to refuse sharing an account with INVENTORY_VARIANCE (owner decision #2).
    usage: 'manual' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },

  // Pembelian (STT/PI flow)
  ACCRUED_PAYABLE: {
    key: 'ACCRUED_PAYABLE',
    label: 'Hutang Belum Tagih',
    description:
      'Accrual: posted CR saat STT/BPB submit (barang sudah diterima, ' +
      'invoice belum). Reversed DR saat PI submit.',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'LIABILITY' as const,
  },
  PURCHASE_PRICE_VARIANCE: {
    key: 'PURCHASE_PRICE_VARIANCE',
    label: 'Selisih Harga Pembelian',
    description:
      'Variance antara harga STT (locked) dan harga PI (aktual). DR kalau ' +
      'PI lebih mahal, CR kalau lebih murah.',
    multiAccount: false,
    required: false,
    usage: 'posting' as RoleUsage,
    expectedRootType: 'EXPENSE' as const,
  },
} as const;

/** Error code: a role the code posts to has no mapped account. */
export const ACCOUNT_MAPPING_MISSING = 'ACCOUNT_MAPPING_MISSING';
/** Error code: two roles with different meanings were mapped to one account. */
export const ACCOUNT_ROLE_CONFLICT = 'ACCOUNT_ROLE_CONFLICT';

export type SystemAccountRole = keyof typeof SYSTEM_ACCOUNT_ROLES;

/**
 * Roles the posting code writes to. A mapping to a group or inactive account breaks the next
 * posting, so startup and the mapping audit watch these. Same set as the roles whose usage is
 * 'posting' (a unit test keeps the two in step).
 */
export const POSTING_SYSTEM_ROLES = [
  'CASH', 'AR', 'AP', 'INVENTORY', 'SALES', 'SERVICE_REVENUE', 'VENDOR_DEPOSIT', 'CUSTOMER_DEPOSIT',
  'COGS', 'OPENING_EQUITY', 'RETAINED_EARNINGS', 'CURRENT_PROFIT', 'TAX_OUTPUT', 'ACCRUED_PAYABLE',
  'PROJECT_GUARANTEE', 'INVENTORY_VARIANCE', 'OTHER_EXPENSE', 'EMPLOYEE_ADVANCE',
  'SALES_RETURN', 'PRODUCTION_CONVERSION', 'PURCHASE_PRICE_VARIANCE',
] as const satisfies readonly SystemAccountRole[];

/**
 * Roles that mean something different from every other role in this list: one account cannot
 * carry two of them (a subledger control account, the sales/COGS pair, the equity roll-forward
 * pair). An exclusive role also refuses to share with any other role (so CASH cannot sit on
 * the AR account); only two non-exclusive roles may share (e.g. rounding and inventory variance).
 */
export const EXCLUSIVE_MAPPING_ROLES = [
  'AR', 'AP', 'INVENTORY', 'VENDOR_DEPOSIT', 'CUSTOMER_DEPOSIT', 'ACCRUED_PAYABLE',
  'SALES', 'COGS', 'TAX_INPUT', 'TAX_OUTPUT', 'RETAINED_EARNINGS', 'CURRENT_PROFIT',
] as const satisfies readonly SystemAccountRole[];

export const ALL_SYSTEM_ROLES = Object.keys(SYSTEM_ACCOUNT_ROLES) as SystemAccountRole[];

export const REQUIRED_SYSTEM_ROLES = ALL_SYSTEM_ROLES.filter(
  (k) => SYSTEM_ACCOUNT_ROLES[k].required,
);

/** Roles of one usage kind, in registry order. */
export function rolesByUsage(usage: RoleUsage): SystemAccountRole[] {
  return ALL_SYSTEM_ROLES.filter((k) => SYSTEM_ACCOUNT_ROLES[k].usage === usage);
}
