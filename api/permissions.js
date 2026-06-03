'use strict';

const USER_ROLES = { ADMIN: 'admin', MODERATOR: 'moderator', USER: 'user' };

const PERMISSIONS = {
    VIEW_ALBUM: 'view_album',
    CREATE_ALBUM: 'create_album',
    EDIT_ALBUM: 'edit_album',
    DELETE_ALBUM: 'delete_album',
    MANAGE_USERS: 'manage_users',
};

const ROLE_PERMISSIONS = {
    [USER_ROLES.ADMIN]: [
        PERMISSIONS.VIEW_ALBUM,
        PERMISSIONS.CREATE_ALBUM,
        PERMISSIONS.EDIT_ALBUM,
        PERMISSIONS.DELETE_ALBUM,
        PERMISSIONS.MANAGE_USERS,
    ],
    [USER_ROLES.MODERATOR]: [
        PERMISSIONS.VIEW_ALBUM,
        PERMISSIONS.CREATE_ALBUM,
        PERMISSIONS.EDIT_ALBUM,
        PERMISSIONS.DELETE_ALBUM,
    ],
    [USER_ROLES.USER]: [
        PERMISSIONS.VIEW_ALBUM,
        PERMISSIONS.CREATE_ALBUM,
        PERMISSIONS.EDIT_ALBUM,
    ],
};

function hasPermission(userRole, permission) {
    return ROLE_PERMISSIONS[userRole]?.includes(permission) ?? false;
}

// Emails configured as permanent admins, e.g. ADMIN_EMAILS="me@x.com,you@y.com".
// Parsed fresh each call so env changes take effect without a code change.
function getAdminEmails() {
    return (process.env.ADMIN_EMAILS || '')
        .split(',')
        .map(email => email.trim().toLowerCase())
        .filter(Boolean);
}

// Resolve a user's effective role. Any email in ADMIN_EMAILS is always treated
// as admin regardless of the stored DB value — this bootstraps the first admin
// and keeps admin status across DB resets/reseeds.
function resolveRole(email, dbRole) {
    if (email && getAdminEmails().includes(email.toLowerCase())) {
        return USER_ROLES.ADMIN;
    }
    return dbRole || USER_ROLES.USER;
}

// ADMIN/MODERATOR bypass ownership for edit/delete; USER must own the resource.
function canPerformAction(userRole, permission, resourceOwnerId, userId) {
    if (!hasPermission(userRole, permission)) return false;
    if (permission === PERMISSIONS.EDIT_ALBUM || permission === PERMISSIONS.DELETE_ALBUM) {
        if (userRole === USER_ROLES.ADMIN || userRole === USER_ROLES.MODERATOR) return true;
        return resourceOwnerId === userId;
    }
    return true;
}

module.exports = { USER_ROLES, PERMISSIONS, ROLE_PERMISSIONS, hasPermission, canPerformAction, resolveRole };
