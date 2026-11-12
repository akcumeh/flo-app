import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import s from './Dock.module.scss';

export const TABS: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/home', label: 'Home', icon: 'nav-home' },
  { to: '/prep', label: 'Prep', icon: 'nav-prep' },
  { to: '/ask', label: 'Ask', icon: 'nav-ask' },
  { to: '/progress', label: 'Progress', icon: 'nav-progress' },
];

export function Dock({ children }: { children?: ReactNode }) {
  return (
    <div className={s.dock}>
      {children ? <div className={s.extra}>{children}</div> : null}
      <nav className={s.bar} aria-label="Primary">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={({ isActive }) => (isActive ? `${s.tab} ${s.active}` : s.tab)}>
            <span className={s.iconWrap}>
              <Icon name={tab.icon} />
            </span>
            <span className={s.label}>{tab.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
