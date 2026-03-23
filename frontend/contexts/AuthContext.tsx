import React, { createContext, useContext, useEffect, useState } from 'react';
import { getUser, login as loginApi, type AuthLoginMode } from '../api';
import { MenuPermission, PlatformRole, User } from '../types';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (mode?: AuthLoginMode) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// resolvePlatformRole
// 是什么：平台角色归一化函数。
// 做什么：优先读取后端返回的 `platform_role`，并兼容旧接口仅返回 `role` 的场景。
// 为什么：系统已升级为超级管理员/管理员/执行对象三层模型，前端必须兼容新旧返回结构。
const resolvePlatformRole = (rawPlatformRole: unknown, rawLegacyRole: unknown): PlatformRole => {
  const normalizedPlatformRole = String(rawPlatformRole || '').trim().toUpperCase();
  if (normalizedPlatformRole === 'SUPER_ADMIN') {
    return 'SUPER_ADMIN';
  }
  if (normalizedPlatformRole === 'ADMIN') {
    return 'ADMIN';
  }
  if (normalizedPlatformRole === 'EXECUTOR') {
    return 'EXECUTOR';
  }

  const normalizedLegacyRole = String(rawLegacyRole || '').trim().toUpperCase();
  return normalizedLegacyRole === 'MANAGER' ? 'ADMIN' : 'EXECUTOR';
};

// buildMenuPermissions
// 是什么：菜单权限兜底构建函数。
// 做什么：在后端未显式返回菜单权限时，按平台角色生成默认菜单集合。
// 为什么：兼容旧接口与测试桩，避免前端菜单在权限升级过程中空白。
const buildMenuPermissions = (platformRole: PlatformRole, rawMenuPermissions: unknown): MenuPermission[] => {
  if (Array.isArray(rawMenuPermissions) && rawMenuPermissions.length > 0) {
    return rawMenuPermissions
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean) as MenuPermission[];
  }

  if (platformRole === 'SUPER_ADMIN' || platformRole === 'ADMIN') {
    return ['DASHBOARD', 'TASKS', 'CALENDAR', 'TEAM_STATS', 'SETTINGS'];
  }

  return ['TASKS', 'CALENDAR'];
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const initAuth = async () => {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');

      if (token) {
        localStorage.setItem('token', token);
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      const storedToken = localStorage.getItem('token');
      if (!storedToken) {
        setUser(null);
        setLoading(false);
        return;
      }

      try {
        const userData = await getUser();
        const platformRole = resolvePlatformRole(userData.platform_role, userData.role);
        setUser({
          id: userData.userid,
          name: userData.name,
          avatar: userData.avatar || '',
          role: platformRole === 'EXECUTOR' ? 'EXECUTOR' : 'MANAGER',
          platformRole,
          isAdmin: Boolean(userData.is_admin ?? (platformRole === 'SUPER_ADMIN' || platformRole === 'ADMIN')),
          isSuperAdmin: Boolean(userData.is_super_admin ?? platformRole === 'SUPER_ADMIN'),
          menuPermissions: buildMenuPermissions(platformRole, userData.menu_permissions),
        });
      } catch (error) {
        console.error('Failed to fetch user', error);
        localStorage.removeItem('token');
        setUser(null);
      }

      setLoading(false);
    };

    initAuth();
  }, []);

  const login = (mode: AuthLoginMode = 'auto') => {
    loginApi(mode);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
