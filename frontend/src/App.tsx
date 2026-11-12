import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { useAccount } from './state/AccountContext';
import { AddNotesScreen } from './screens/AddNotesScreen';
import { AppearanceScreen } from './screens/AppearanceScreen';
import { MaterialScreen } from './screens/MaterialScreen';
import { AskScreen } from './screens/AskScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { OnboardingScreen } from './screens/OnboardingScreen';
import { PrepHomeScreen } from './screens/PrepHomeScreen';
import { PrepSessionScreen } from './screens/PrepSessionScreen';
import { ProfileScreen } from './screens/ProfileScreen';
import { ProgressScreen } from './screens/ProgressScreen';
import { SessionExpiredScreen } from './screens/SessionExpiredScreen';
import { SignInScreen } from './screens/SignInScreen';
import { TelegramWaitScreen } from './screens/TelegramWaitScreen';
import { VerifyScreen } from './screens/VerifyScreen';
import s from './screens/Auth.module.scss';

export function Splash() {
    return (
        <div className={s.splash} aria-busy="true" aria-label="Loading Florence">
            <svg width="88" height="84" viewBox="0 0 14 13.3731" aria-hidden="true">
                <path
                    d="M13.8657 5.99929L9.74887 7.49913L12.7026 10.8814L9.97843 13.2383L6.93286 9.77948L3.8873 13.2383L1.16313 10.8814L4.14747 7.52974L0 5.99929L1.25496 2.50991L5.11165 3.99443V0H8.75408V3.99443L12.6108 2.50991L13.8657 5.99929Z"
                    fill="#ffffff"
                />
            </svg>
        </div>
    );
}

function RequireAccount() {
    const { status, account } = useAccount();
    const location = useLocation();
    const from = `${location.pathname}${location.search}`;
    if (status === 'loading') return <Splash />;
    if (status === 'expired') return <SessionExpiredScreen from={from} />;
    if (status === 'signedOut') return <Navigate to="/signin" replace state={{ from }} />;
    const onboarding =
        location.pathname === '/onboarding' ||
        location.pathname === '/profile' ||
        location.pathname.startsWith('/settings');
    if (account && !account.profile?.onboardingComplete && !onboarding) {
        return <Navigate to="/onboarding" replace />;
    }
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
                <Route path="/onboarding" element={<OnboardingScreen />} />
                <Route path="/profile" element={<ProfileScreen />} />
                <Route path="/settings/appearance" element={<AppearanceScreen />} />
                <Route element={<AppShell />}>
                    <Route path="/home" element={<HomeScreen />} />
                    <Route path="/ask" element={<AskScreen />} />
                    <Route path="/prep" element={<PrepHomeScreen />} />
                    <Route path="/prep/:id" element={<PrepSessionScreen />} />
                    <Route path="/library" element={<LibraryScreen />} />
                    <Route path="/library/add" element={<AddNotesScreen />} />
                    <Route path="/library/:id" element={<MaterialScreen />} />
                    <Route path="/progress" element={<ProgressScreen />} />
                </Route>
            </Route>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
    );
}
