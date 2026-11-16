// Catalogue des permissions et matrice par defaut des roles (docs Phase 1, section Roles).
// Format : "module.action" ; actions : read (L), write (E), validate (V), delete (S).
export const ROLES = [
  { code: 'owner', name: 'Propriétaire' },
  { code: 'admin', name: 'Administrateur' },
  { code: 'accountant', name: 'Comptable' },
  { code: 'sales', name: 'Commercial' },
  { code: 'stock_manager', name: 'Gestionnaire de stock' },
  { code: 'read_only', name: 'Lecture seule' },
];

// module -> { role: 'rwvd' } (r=read, w=write, v=validate, d=delete) ; role absent = aucun acces
const MATRIX = {
  client:           { owner: 'rwd',  admin: 'rwd',  accountant: 'rw',  sales: 'rw',  stock_manager: 'r',   read_only: 'r' },
  supplier:         { owner: 'rwd',  admin: 'rwd',  accountant: 'rw',  sales: 'rw',  stock_manager: 'r',   read_only: 'r' },
  product:          { owner: 'rwd',  admin: 'rwd',  accountant: 'rw',  sales: 'r',   stock_manager: 'rw',  read_only: 'r' },
  quote:            { owner: 'rwvd', admin: 'rwvd', accountant: 'r',   sales: 'rwv', stock_manager: 'r',   read_only: 'r' },
  sales_order:      { owner: 'rwvd', admin: 'rwvd', accountant: 'r',   sales: 'rwv', stock_manager: 'r',   read_only: 'r' },
  invoice:          { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', sales: 'rw',  read_only: 'r' },
  credit_note:      { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', sales: 'rw',  read_only: 'r' },
  delivery:         { owner: 'rwvd', admin: 'rwvd', accountant: 'r',   sales: 'rwv', stock_manager: 'rwv', read_only: 'r' },
  purchase:         { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', stock_manager: 'r', read_only: 'r' },
  purchase_receipt: { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', stock_manager: 'rwv', read_only: 'r' },
  sales_return:     { owner: 'rwvd', admin: 'rwvd', accountant: 'r',   sales: 'rwv', stock_manager: 'rwv', read_only: 'r' },
  purchase_return:  { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', stock_manager: 'rwv', read_only: 'r' },
  payment:          { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', sales: 'r',   read_only: 'r' },
  treasury:         { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', sales: 'r',   read_only: 'r' },
  withholding:      { owner: 'rwv',  admin: 'rwv',  accountant: 'rwv', read_only: 'r' },
  expense_note:     { owner: 'rwvd', admin: 'rwvd', accountant: 'rwv', sales: 'r',   read_only: 'r' },
  project:          { owner: 'rwd',  admin: 'rwd',  accountant: 'rw',  sales: 'rw',  stock_manager: 'r', read_only: 'r' },
  stock:            { owner: 'rwvd', admin: 'rwvd', accountant: 'r',   sales: 'r',   stock_manager: 'rwvd', read_only: 'r' },
  report:           { owner: 'r', admin: 'r', accountant: 'r', sales: 'r', stock_manager: 'r', read_only: 'r' },
  einvoice:         { owner: 'rwv',  admin: 'rwv',  accountant: 'rwv', sales: 'r',   read_only: 'r' },
  user:             { owner: 'rwd',  admin: 'rw' },
  settings:         { owner: 'rw',   admin: 'rw' },
  tax_rate:         { owner: 'rwd', admin: 'rwd', accountant: 'rwd', sales: 'r', stock_manager: 'r', read_only: 'r' },
  subscription:     { owner: 'rw',   admin: 'r' },
};

const ACTION = { r: 'read', w: 'write', v: 'validate', d: 'delete' };

// Vue lecture seule de la matrice (module -> rôle -> actions) : sert à l'écran « Droits par rôle » et aux tests.
export const permissionMatrix = () => ({ roles: ROLES, modules: Object.entries(MATRIX).map(([module, byRole]) => ({ module, rights: Object.fromEntries(ROLES.map((r) => [r.code, (byRole[r.code] ?? '').split('').map((a) => ACTION[a])])) })) });

export const PERMISSIONS = Object.entries(MATRIX).flatMap(([mod, byRole]) => {
  const actions = new Set(Object.values(byRole).join('').split(''));
  return [...actions].map((a) => `${mod}.${ACTION[a]}`);
});

export function permissionsForRole(roleCode) {
  return Object.entries(MATRIX).flatMap(([mod, byRole]) =>
    (byRole[roleCode] ?? '').split('').filter(Boolean).map((a) => `${mod}.${ACTION[a]}`),
  );
}

// Synchronise roles, permissions et role_permissions (idempotent, conserve les ids existants).
export async function syncRolesAndPermissions(conn) {
  for (const r of ROLES) {
    await conn.query(
      'INSERT INTO roles (code, name, is_system) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE name = VALUES(name)',
      [r.code, r.name],
    );
  }
  for (const code of PERMISSIONS) {
    await conn.query('INSERT IGNORE INTO permissions (code) VALUES (?)', [code]);
  }
  for (const r of ROLES) {
    const [[role]] = await conn.query('SELECT id FROM roles WHERE code = ?', [r.code]);
    const wanted = permissionsForRole(r.code);
    await conn.query('DELETE FROM role_permissions WHERE role_id = ?', [role.id]);
    if (wanted.length) {
      await conn.query(
        'INSERT INTO role_permissions (role_id, permission_id) SELECT ?, id FROM permissions WHERE code IN (?)',
        [role.id, wanted],
      );
    }
  }
}
