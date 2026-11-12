import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon';
import { Avatar, Button, Dialog } from '../components/ui';
import { useAccount } from '../state/AccountContext';
import { useAppearance } from '../state/theme';
import s from './Profile.module.scss';

interface Row {
    icon: IconName;
    label: string;
    value?: string;
    to?: string;
}

const APPEARANCE: Record<string, string> = { light: 'Light', dark: 'Dark', system: 'System' };

export function ProfileScreen() {
    const navigate = useNavigate();
    const { account, signOut } = useAccount();
    const [appearance] = useAppearance();
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const profile = account?.profile;
    const chats = (account?.identities ?? [])
        .filter((i) => i.provider === 'telegram' || i.provider === 'whatsapp')
        .map((i) => (i.provider === 'telegram' ? 'Telegram' : 'WhatsApp'));
    const meta = [
        profile?.department?.name,
        profile?.level ? `${profile.level}L` : null,
        profile?.school?.name,
    ]
        .filter(Boolean)
        .join(' · ');

    const groups: Row[][] = [
        [
            { icon: 'school', label: 'School and courses', to: '/onboarding' },
            { icon: 'bolt', label: 'Tokens and plans', value: String(account?.tokenBalance ?? '') },
            { icon: 'link', label: 'Linked chats', value: chats.join(', ') || undefined },
        ],
        [
            { icon: 'bell', label: 'Notifications' },
            {
                icon: 'moon',
                label: 'Appearance',
                value: APPEARANCE[appearance],
                to: '/settings/appearance',
            },
        ],
        [
            { icon: 'help', label: 'Help and FAQ' },
            { icon: 'chat', label: 'Contact support' },
            { icon: 'shield', label: 'Privacy and data' },
        ],
    ];

    const logOut = async () => {
        setBusy(true);
        await signOut();
        navigate('/signin', { replace: true });
    };

    return (
        <div className={s.page}>
            <header className={s.bar}>
                <button
                    type="button"
                    className={s.back}
                    aria-label="Back"
                    onClick={() => navigate(-1)}
                >
                    <Icon name="arrow-left" />
                </button>
                <h1 className={s.barTitle}>Profile</h1>
                <span className={s.back} aria-hidden="true" />
            </header>
            <main className={s.body}>
                <section className={s.who}>
                    <Avatar name={account?.displayName} size={56} />
                    <div>
                        <p className={s.name}>{account?.displayName}</p>
                        {meta ? <p className={s.meta}>{meta}</p> : null}
                    </div>
                </section>
                {groups.map((rows, g) => (
                    <section key={g} className={s.group}>
                        {rows.map((row) => (
                            <button
                                key={row.label}
                                type="button"
                                className={s.row}
                                disabled={!row.to}
                                onClick={() => row.to && navigate(row.to)}
                            >
                                <Icon name={row.icon} className={s.rowIcon} />
                                <span className={s.rowLabel}>{row.label}</span>
                                {row.value ? <span className={s.rowValue}>{row.value}</span> : null}
                                {row.to ? <Icon name="chevron" className={s.chevron} /> : null}
                            </button>
                        ))}
                    </section>
                ))}
                <Button variant="link" block onClick={() => setConfirm(true)}>
                    Log out
                </Button>
            </main>
            <Dialog open={confirm} onClose={() => setConfirm(false)} title="Log out?">
                <p className={s.meta}>You can log back in with WhatsApp, Google or Telegram.</p>
                <div className={s.actions}>
                    <Button block loading={busy} onClick={() => void logOut()}>
                        Log out
                    </Button>
                    <Button variant="ghost" block onClick={() => setConfirm(false)}>
                        Cancel
                    </Button>
                </div>
            </Dialog>
        </div>
    );
}
