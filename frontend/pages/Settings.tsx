import React, { useEffect, useState } from 'react';
import { Bell, Globe, Save, ShieldCheck } from 'lucide-react';
import { useTranslation } from '../contexts/LanguageContext';

interface SettingsProps {
  onSyncTasks: () => Promise<void>;
}

interface SettingsState {
  autoSyncEnabled: boolean;
  notificationEnabled: boolean;
  preferredLanguage: 'zh' | 'en';
}

const STORAGE_KEY = 'wecom-task-bot-settings';

const SettingsPage: React.FC<SettingsProps> = ({ onSyncTasks }) => {
  const { t, language, setLanguage } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [manualSyncing, setManualSyncing] = useState(false);
  const [settings, setSettings] = useState<SettingsState>({
    autoSyncEnabled: true,
    notificationEnabled: true,
    preferredLanguage: language,
  });

  useEffect(() => {
    const savedText = localStorage.getItem(STORAGE_KEY);
    if (!savedText) {
      setSettings((prev) => ({ ...prev, preferredLanguage: language }));
      return;
    }

    try {
      const parsed = JSON.parse(savedText) as SettingsState;
      const nextLanguage = parsed.preferredLanguage === 'en' ? 'en' : 'zh';
      setSettings({
        autoSyncEnabled: Boolean(parsed.autoSyncEnabled),
        notificationEnabled: Boolean(parsed.notificationEnabled),
        preferredLanguage: nextLanguage,
      });
      setLanguage(nextLanguage);
    } catch (error) {
      console.error(error);
    }
  }, [language, setLanguage]);

  const saveSettings = async () => {
    try {
      setSaving(true);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      setLanguage(settings.preferredLanguage);
    } finally {
      setSaving(false);
    }
  };

  const triggerManualSync = async () => {
    try {
      setManualSyncing(true);
      await onSyncTasks();
    } finally {
      setManualSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{t.settingsTitle}</h1>
        <p className="text-sm text-slate-500 mt-1">{t.settingsDesc}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Bell className="w-5 h-5 text-amber-500" />
            {t.settingsNotification}
          </h2>

          <label className="flex items-center justify-between text-sm text-slate-700">
            <span>{t.settingsTaskReminderToggle}</span>
            <input
              type="checkbox"
              checked={settings.notificationEnabled}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  notificationEnabled: event.target.checked,
                }))
              }
              className="w-4 h-4"
            />
          </label>

          <label className="flex items-center justify-between text-sm text-slate-700">
            <span>{t.settingsAutoSyncToggle}</span>
            <input
              type="checkbox"
              checked={settings.autoSyncEnabled}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  autoSyncEnabled: event.target.checked,
                }))
              }
              className="w-4 h-4"
            />
          </label>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-500" />
            {t.settingsDisplay}
          </h2>

          <label className="block text-sm text-slate-700">
            <span className="block mb-2">{t.settingsLanguage}</span>
            <select
              value={settings.preferredLanguage}
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  preferredLanguage: event.target.value === 'en' ? 'en' : 'zh',
                }))
              }
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-emerald-500" />
          {t.settingsOperations}
        </h2>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={triggerManualSync}
            disabled={manualSyncing}
            className="px-4 py-2 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
          >
            {manualSyncing ? t.syncing : t.settingsManualSync}
          </button>

          <button
            onClick={saveSettings}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            <Save className="w-4 h-4" />
            {saving ? t.saving : t.saveSettings}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;
