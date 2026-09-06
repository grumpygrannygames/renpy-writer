label ch2_arrival:
    scene bg_kitchen
    show ava happy at left
    # Beat 1

    ava "Line 1 of beat 1."
    ben happy "Line 2 of beat 1."
    cora "Line 3 of beat 1."
    nico "Line 4 of beat 1."
    dev "Line 5 of beat 1."
    ava_thoughts "Line 6 of beat 1."
    "The room settles around them."
    ava "Nevím, jestli to zvládnu."
    ben "Line 9 of beat 1."
    # A pause, long enough to notice
    cora "It is not that simple."
    nico "Line 11 of beat 1."
    dev "Line 12 of beat 1."
    ava_thoughts "Line 13 of beat 1."
    quinn "Line 14 of beat 1."

label ch2_kettle:
    scene bg_kitchen
    show ben thinking at right
    # Beat 2

    ava_thoughts "Line 1 of beat 2."
    quinn "Jag vet inte vad jag ska säga."
    ava "Line 3 of beat 2."
    ben "Line 4 of beat 2."
    cora "Line 5 of beat 2."
    nico "Line 6 of beat 2."
    "The room settles around them."
    ava_thoughts "Line 8 of beat 2."
    quinn "Line 9 of beat 2."
    ava tired "何も言わずに、彼女は手紙を二度読んだ。"
    ben "Line 11 of beat 2."
    cora "Line 12 of beat 2."
    nico "Line 13 of beat 2."
    dev "Line 14 of beat 2."

label ch2_argument:
    scene bg_kitchen
    show ava_alter quiet at center
    # Beat 3

    nico "Line 1 of beat 3."
    dev "Line 2 of beat 3."
    ava_thoughts "Line 3 of beat 3."
    quinn "Всё уже решено."
    ava "Line 5 of beat 3."
    ben happy "Line 6 of beat 3."
    "The room settles around them."
    nico "Line 8 of beat 3."
    dev "Line 9 of beat 3."
    # A pause, long enough to notice
    ava_thoughts "It is not that simple."
    quinn "Line 11 of beat 3."
    ava "Prosím tě, nech toho."
    ben "Line 13 of beat 3."
    cora "Line 14 of beat 3."

    menu:
        "Let it go":
            ben "Fine."
        "Push":
            ben "No, say it properly."

label ch2_walk:
    scene bg_road
    show ava happy at left
    # Beat 4

    ben "Line 1 of beat 4."
    cora "Line 2 of beat 4."
    nico "Line 3 of beat 4."
    dev "Line 4 of beat 4."
    ava_thoughts "Line 5 of beat 4."
    quinn "Skölden är trasig, vi måste vända om."
    "The room settles around them."
    ben "Line 8 of beat 4."
    cora "Line 9 of beat 4."
    # A pause, long enough to notice
    nico "It is not that simple."
    dev "Line 11 of beat 4."
    ava_thoughts "Line 12 of beat 4."
    quinn "Line 13 of beat 4."
    ava smirk "ドアが閉まる音がした。"

label ch2_yard:
    scene bg_yard
    show ben thinking at right
    # Beat 5

    quinn "Line 1 of beat 5."
    ava sad "Line 2 of beat 5."
    ben "Line 3 of beat 5."
    cora "Line 4 of beat 5."
    nico "Line 5 of beat 5."
    dev "Line 6 of beat 5."
    "The room settles around them."
    quinn "Το γράμμα ήταν άδειο."
    ava "Line 9 of beat 5."
    # A pause, long enough to notice
    ben happy "It is not that simple."
    cora "Line 11 of beat 5."
    nico "Line 12 of beat 5."
    dev "Line 13 of beat 5."
    ava_thoughts "Line 14 of beat 5."

label ch2_letter:
    scene bg_yard
    show ava_alter quiet at center
    # Beat 6

    dev "Line 1 of beat 6."
    ava_thoughts "Zítra ráno vyrazíme, ať se děje co se děje."
    quinn "Line 3 of beat 6."
    ava "Line 4 of beat 6."
    ben "Line 5 of beat 6."
    cora "Line 6 of beat 6."
    "The room settles around them."
    dev "Line 8 of beat 6."
    ava_thoughts "Line 9 of beat 6."
    quinn "Han sa ingenting på hela kvällen."
    ava "Line 11 of beat 6."
    ben "Line 12 of beat 6."
    cora "Line 13 of beat 6."
    nico "Line 14 of beat 6."

    if trust > 2:
        ava happy "You would really come?"
    else:
        ava sad "You would not."

label ch2_night:
    scene bg_road
    show ava happy at left
    # Beat 7

    cora "Line 1 of beat 7."
    nico "Line 2 of beat 7."
    dev "Line 3 of beat 7."
    ava_thoughts "彼は答えなかった。"
    quinn "Line 5 of beat 7."
    ava happy "Line 6 of beat 7."
    "The room settles around them."
    cora "Line 8 of beat 7."
    nico "Line 9 of beat 7."
    # A pause, long enough to notice
    dev "It is not that simple."
    ava_thoughts "Line 11 of beat 7."
    quinn "Она уже ушла."
    ava "Line 13 of beat 7."
    ben happy "Line 14 of beat 7."

    jump ch2_dream

label ch2_dream:
    scene bg_road
    show ben thinking at right
    # Beat 8

    ava "Line 1 of beat 8."
    ben happy "Line 2 of beat 8."
    cora "Line 3 of beat 8."
    nico "Line 4 of beat 8."
    dev "Line 5 of beat 8."
    ava_thoughts "Nevím, jestli to zvládnu."
    "The room settles around them."
    ava "Line 8 of beat 8."
    ben "Line 9 of beat 8."
    # A pause, long enough to notice
    cora "It is not that simple."
    nico "Line 11 of beat 8."
    dev "Line 12 of beat 8."
    ava_thoughts "Line 13 of beat 8."
    quinn "Jag vet inte vad jag ska säga."

    jump ch2_morning

label ch2_morning:
    scene bg_kitchen
    show ava_alter quiet at center
    # Beat 9

    ava_thoughts "Line 1 of beat 9."
    quinn "Line 2 of beat 9."
    ava "Line 3 of beat 9."
    ben "Line 4 of beat 9."
    cora "Line 5 of beat 9."
    nico "Line 6 of beat 9."
    "The room settles around them."
    ava_thoughts "何も言わずに、彼女は手紙を二度読んだ。"
    quinn "Line 9 of beat 9."
    # A pause, long enough to notice
    ava tired "It is not that simple."
    ben "Line 11 of beat 9."
    cora "Line 12 of beat 9."
    nico "Line 13 of beat 9."
    dev "Line 14 of beat 9."

    return

