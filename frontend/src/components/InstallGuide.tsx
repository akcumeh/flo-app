import { useEffect, useState } from 'react';
import { isIos, isStandalone } from '../lib/push';
import { Button, Dialog, Lead, Sheet, Steps } from './ui';

const IOS_STEPS = [
    { title: 'Tap Share', body: 'The square with an arrow, at the bottom of Safari.' },
    { title: 'Choose “Add to Home Screen”', body: "Scroll down the list if you can't see it." },
    { title: 'Tap Add', body: 'Florence opens like an app, full screen.' },
];

const DESKTOP_STEPS = [
    {
        title: 'Click the install icon',
        body: "It's at the right end of the address bar in Chrome or Edge.",
    },
    { title: 'Choose Install', body: 'Florence opens in its own window.' },
    { title: 'Pin it', body: 'Pin it to your taskbar or dock to open it in one click.' },
];

const SEEN = 'florence.installGuideSeen';

export function InstallGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
    if (isIos()) {
        return (
            <Sheet open={open} onClose={onClose} title="Add Florence to your home screen">
                <Lead>It opens faster and works better on a weak connection.</Lead>
                <Steps steps={IOS_STEPS} />
                <Button block onClick={onClose}>
                    Got it
                </Button>
            </Sheet>
        );
    }
    return (
        <Dialog open={open} onClose={onClose} title="Install Florence on this computer">
            <Lead>It opens in its own window and works better on a weak connection.</Lead>
            <Steps steps={DESKTOP_STEPS} />
            <Button block onClick={onClose}>
                Got it
            </Button>
        </Dialog>
    );
}

function seen(): boolean {
    try {
        return localStorage.getItem(SEEN) === '1';
    } catch {
        return true;
    }
}

export function useInstallGuide(): [boolean, () => void] {
    const [open, setOpen] = useState(false);
    useEffect(() => {
        if (!seen() && !isStandalone() && isIos()) setOpen(true);
    }, []);
    const close = () => {
        setOpen(false);
        try {
            localStorage.setItem(SEEN, '1');
        } catch {
            return;
        }
    };
    return [open, close];
}
