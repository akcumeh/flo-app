import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { client } from '../api';
import { useAccount } from '../state/AccountContext';
import { Icon } from './Icon';
import { Avatar, Chip } from './ui';
import s from './Header.module.scss';

export function useStreak() {
    const { status } = useAccount();
    return useQuery({
        queryKey: ['streak'],
        enabled: status === 'signedIn',
        queryFn: async () => (await client.GET('/v1/streak')).data!,
    });
}

export function TokenChip() {
    const { account } = useAccount();
    const balance = account?.tokenBalance;
    return (
        <Link
            to="/tokens"
            className={s.chipLink}
            aria-label={balance === undefined ? 'Tokens' : `${balance} tokens`}
        >
            <Chip tone="sun" icon={<Icon name="bolt" />}>
                <span aria-live="polite">{balance ?? '…'}</span>
            </Chip>
        </Link>
    );
}

export function StreakChip() {
    const streak = useStreak();
    const current = streak.data?.current;
    return (
        <Link
            to="/progress"
            className={s.chipLink}
            aria-label={current === undefined ? 'Streak' : `${current} day streak`}
        >
            <Chip tone="fire" icon={<Icon name="fire" />}>
                {current ?? '…'}
            </Chip>
        </Link>
    );
}

interface HeaderProps {
    onNewChat?: () => void;
}

export function Header({ onNewChat }: HeaderProps) {
    const { account } = useAccount();
    return (
        <header className={s.header}>
            <Link to="/home" aria-label="Florence home" className={s.logoLink}>
                <Icon name="logo-florence" className={s.logo} />
            </Link>
            <div className={s.actions}>
                <StreakChip />
                <TokenChip />
                {onNewChat ? (
                    <button
                        type="button"
                        className={s.newChat}
                        onClick={onNewChat}
                        aria-label="New chat"
                    >
                        <Icon name="new-chat" />
                    </button>
                ) : (
                    <Link to="/profile" aria-label="Profile" className={s.chipLink}>
                        <Avatar name={account?.displayName} />
                    </Link>
                )}
            </div>
        </header>
    );
}
