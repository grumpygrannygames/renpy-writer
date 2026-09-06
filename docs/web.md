# Writing from a phone or another computer

Ren'Py Writer can run on one machine and be used from another — a phone on the
sofa, a laptop elsewhere in the house, or a small rented server so you can write
from anywhere.

The screen layout adapts: on a phone you get one panel at a time and a row of
buttons along the bottom, sized for thumbs.

**This is the most involved thing in here.** It is not needed to use the app,
and everything else works without it. If you only ever write at your own
computer, you can close this page.

## What you are setting up

One machine holds the story and runs Ren'Py Writer in the background. Other
devices open it in a web browser and sign in. There is no app to install on the
phone.

Everyone is editing the same copy of the story, so it behaves like one desk that
several people can sit at, rather than several copies to reconcile later.

## Before you start

You need:

- **The machine that will hold it**, left switched on while you want to use it.
  Your own computer works; so does a small rented one, which is what you want if
  you plan to write while away from home.
- **Ren'Py Writer set up on that machine**, as described in the main README.
- **Your story in version control**, if more than one person will write. Not
  needed if it is only you.

## Making an account

There is no sign-up page: accounts are made on the machine that runs it, by
whoever runs it. Open a terminal in the Ren'Py Writer folder and run:

```
npm run account -- add yourname --role admin --email you@example.com
```

It asks for a password twice and shows nothing as you type, which is normal. The
password is not stored — only something derived from it, which cannot be turned
back.

The email address matters if your story is in version control: work saved from
the phone is recorded under it, so the history says who wrote what.

To add somebody else later, run it again with a different name. Leave off
`--role admin` and they get an ordinary writer's account.

## Starting it

```
npm run serve -- --project /path/to/your/game --host 0.0.0.0 --allow-network
```

Replace the path with the folder containing `game/`. The two options at the end
are what allow other devices to reach it; without them it accepts only the
machine it runs on.

It prints the address to open. On the same home network, that is usually
`http://your-computer-address:4321`.

## Doing this properly on the open internet

On your own home network, the above is fine.

**On a machine reachable from the internet, it is not.** Anything sent over a
plain connection can be read on the way, including the thing that keeps you
signed in. The app knows this and will refuse to sign you in over an unprotected
connection rather than appear to work and quietly fail.

What you need is a certificate, so the connection is encrypted. The usual way is
a small program called Caddy, which obtains and renews one for you, given a
domain name pointing at the machine. That is beyond what this page can usefully
explain — but it is the thing to search for, and it is neither expensive nor
difficult once you know that is what you are looking for.

If you would rather not run any of this yourself, the author may offer it as a
hosted service.

## What is different on a phone

Some things need a real computer and are simply not shown rather than offered
and broken:

- **Choosing a folder** — there is nobody sitting at the machine to answer.
- **Pictures** — the artwork lives on the computer where you make it.
- **Proofreading and translation** — these need a service running on the machine
  that holds the story.

Writing, the outline, characters, notes and sharing your work all behave the
same as on a computer.

## Keeping it running

Started as above, it stops when you close the terminal. To have it start with
the machine and stay running, you want a service — `systemd` on Linux, or Task
Scheduler on Windows. Again beyond this page, but those are the right words to
search for.

The one file worth keeping a copy of is the list of accounts, in `.server-data`.
Losing it means making the accounts again; losing the story does not follow from
it, because the story lives in your game folder and in version control.
