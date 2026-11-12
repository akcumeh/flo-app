import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Icon } from './components/Icon';
import { useAccount } from './state/AccountContext';
import { AppearanceScreen } from './screens/AppearanceScreen';
import { AskScreen } from './screens/AskScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { PrepHomeScreen } from './screens/PrepHomeScreen';
import { PrepSessionScreen } from './screens/PrepSessionScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { SessionExpiredScreen } from './screens/SessionExpiredScreen';
import { SignInScreen } from './screens/SignInScreen';
import { TelegramWaitScreen } from './screens/TelegramWaitScreen';
import { VerifyScreen } from './screens/VerifyScreen';
import s from './screens/Auth.module.scss';

function Splash() {
    return (
        <div className={s.splash} aria-busy="true" aria-label="Loading Florence">
            <Icon name="asterisk-action" />
        </div>
    );
}

function RequireAccount() {
    const { status } = useAccount();
    const location = useLocation();
    const from = `${location.pathname}${location.search}`;
    if (status === 'loading') return <Splash />;
    if (status === 'expired') return <SessionExpiredScreen from={from} />;
    if (status === 'signedOut') return <Navigate to="/signin" replace state={{ from }} />;
    return <Outlet />;
}

function GuestOnly() {
    const { status } = useAccount();
    const location = useLocation();
    if (status === 'loading') return <Splash />;
    if (status === 'signedIn')
        return (
            <Navigate to={(location.state as { from?: string } | null)?.from ?? '/home'} replace />
        );
    return <Outlet />;
}

export function App() {
    return (
        <Routes>
            <Route element={<GuestOnly />}>
                <Route path="/signin" element={<SignInScreen />} />
                <Route path="/signin/code" element={<VerifyScreen />} />
                <Route path="/signin/telegram" element={<TelegramWaitScreen />} />
            </Route>
            <Route element={<RequireAccount />}>
                <Route path="/settings/appearance" element={<AppearanceScreen />} />
                <Route element={<AppShell />}>
                    <Route path="/home" element={<HomeScreen />} />
                    <Route path="/ask" element={<AskScreen />} />
                    <Route path="/prep" element={<PrepHomeScreen />} />
                    <Route path="/prep/:id" element={<PrepSessionScreen />} />
                    <Route path="/library" element={<LibraryScreen />} />
                    <Route path="/progress" element={<ProgressScreen />} />
                </Route>
            </Route>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
    );
}
