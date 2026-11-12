import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { syncAnswers } from '../lib/answerSync';
import { useAccount } from '../state/AccountContext';
import { Icon } from './Icon';
import { InstallGuide, useInstallGuide } from './InstallGuide';
import { Sidebar } from './Sidebar';
import { Banner, useOnline } from './ui';
import s from './AppShell.module.scss';

export function OfflineBanner() {
    const online = useOnline();
    if (online) return null;
    return (
        <div className={s.banner}>
            <Banner icon={<Icon name="wifi-off" />}>
                You're offline. Answers sync when you're back.
            </Banner>
        </div>
    );
}

export function useAnswerSync() {
    const { status } = useAccount();
    const online = useOnline();
    useEffect(() => {
        if (status === 'signedIn' && online) void syncAnswers().catch(() => undefined);
    }, [status, online]);
}

export function AppShell() {
    useAnswerSync();
    const [installOpen, closeInstall] = useInstallGuide();
    return (
        <div className={s.shell}>
            <Sidebar />
            <div className={s.main}>
                <OfflineBanner />
                <Outlet />
            </div>
            <InstallGuide open={installOpen} onClose={closeInstall} />
        </div>
    );
}
