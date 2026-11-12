import { NavLink, useNavigate } from 'react-router-dom';
import { useAccount } from '../state/AccountContext';
import { TABS } from './Dock';
import { TokenChip } from './Header';
import { Icon } from './Icon';
import { Avatar, Button } from './ui';
import s from './Sidebar.module.scss';

export function Sidebar() {
    const navigate = useNavigate();
    const { account } = useAccount();
    const profile = account?.profile;
    const meta = [profile?.school?.name, profile?.level ? `${profile.level}L` : null]
        .filter(Boolean)
        .join(' · ');

    return (
        <aside className={s.sidebar}>
            <NavLink to="/home" className={s.logo} aria-label="Florence home">
                <Icon name="logo-florence" />
            </NavLink>
            <nav className={s.nav} aria-label="Primary">
                {TABS.map((tab) => (
                    <NavLink
                        key={tab.to}
                        to={tab.to}
                        className={({ isActive }) => (isActive ? `${s.item} ${s.active}` : s.item)}
                    >
                        <Icon name={tab.icon} />
                        {tab.label}
                    </NavLink>
                ))}
            </nav>
            <div className={s.bottom}>
                <Button variant="secondary" block onClick={() => navigate('/library')}>
                    Upload notes
                </Button>
                <div className={s.me}>
                    <NavLink to="/profile" className={s.meLink}>
                        <Avatar name={account?.displayName} />
                        <span className={s.meText}>
                            <span className={s.name}>{account?.displayName}</span>
                            {meta ? <span className={s.meta}>{meta}</span> : null}
                        </span>
                    </NavLink>
                    <TokenChip />
                </div>
            </div>
        </aside>
    );
}
