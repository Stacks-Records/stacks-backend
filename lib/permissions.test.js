'use strict';

const { USER_ROLES, PERMISSIONS, hasPermission, canPerformAction, resolveRole } = require('./permissions');

describe('hasPermission', () => {
    test('admin has manage_users', () => {
        expect(hasPermission(USER_ROLES.ADMIN, PERMISSIONS.MANAGE_USERS)).toBe(true);
    });

    test('user does not have manage_users', () => {
        expect(hasPermission(USER_ROLES.USER, PERMISSIONS.MANAGE_USERS)).toBe(false);
    });

    test('user has create_album', () => {
        expect(hasPermission(USER_ROLES.USER, PERMISSIONS.CREATE_ALBUM)).toBe(true);
    });

    test('unknown role has no permissions', () => {
        expect(hasPermission('unknown_role', PERMISSIONS.VIEW_ALBUM)).toBe(false);
    });
});

describe('canPerformAction', () => {
    test('user can edit an album they own', () => {
        expect(canPerformAction(USER_ROLES.USER, PERMISSIONS.EDIT_ALBUM, 'user-1', 'user-1')).toBe(true);
    });

    test('user cannot edit an album they do not own', () => {
        expect(canPerformAction(USER_ROLES.USER, PERMISSIONS.EDIT_ALBUM, 'user-1', 'user-2')).toBe(false);
    });

    test('user cannot delete any album (lacks delete_album permission)', () => {
        expect(canPerformAction(USER_ROLES.USER, PERMISSIONS.DELETE_ALBUM, 'user-1', 'user-1')).toBe(false);
    });

    test('moderator can edit an album they do not own', () => {
        expect(canPerformAction(USER_ROLES.MODERATOR, PERMISSIONS.EDIT_ALBUM, 'user-1', 'user-2')).toBe(true);
    });

    test('admin can delete an album they do not own', () => {
        expect(canPerformAction(USER_ROLES.ADMIN, PERMISSIONS.DELETE_ALBUM, 'user-1', 'user-2')).toBe(true);
    });

    test('user without the underlying permission is denied regardless of ownership', () => {
        expect(canPerformAction(USER_ROLES.USER, PERMISSIONS.MANAGE_USERS, 'user-1', 'user-1')).toBe(false);
    });

    test('view_album is allowed regardless of ownership', () => {
        expect(canPerformAction(USER_ROLES.USER, PERMISSIONS.VIEW_ALBUM, 'user-1', 'user-2')).toBe(true);
    });
});

describe('resolveRole', () => {
    const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

    afterEach(() => {
        process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
    });

    test('email in ADMIN_EMAILS always resolves to admin, overriding dbRole', () => {
        process.env.ADMIN_EMAILS = 'admin@example.com,owner@example.com';
        expect(resolveRole('admin@example.com', USER_ROLES.USER)).toBe(USER_ROLES.ADMIN);
    });

    test('admin email match is case-insensitive', () => {
        process.env.ADMIN_EMAILS = 'admin@example.com';
        expect(resolveRole('ADMIN@EXAMPLE.COM', USER_ROLES.USER)).toBe(USER_ROLES.ADMIN);
    });

    test('email not in ADMIN_EMAILS falls back to dbRole', () => {
        process.env.ADMIN_EMAILS = 'admin@example.com';
        expect(resolveRole('someone@example.com', USER_ROLES.MODERATOR)).toBe(USER_ROLES.MODERATOR);
    });

    test('missing dbRole defaults to user', () => {
        process.env.ADMIN_EMAILS = '';
        expect(resolveRole('someone@example.com', undefined)).toBe(USER_ROLES.USER);
    });
});
