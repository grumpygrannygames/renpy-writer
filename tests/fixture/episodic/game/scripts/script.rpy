# The cast. Everything the writer knows about who speaks comes from here.
#
# Deliberately includes the awkward shapes: two variables that render as
# the same person, a variant with a name of its own, and somebody who is
# never drawn.

define ava = Character('Ava', color="#ffffb2", image="ava")
# Same person, second variable: the writer has to tell these apart.
define ava_thoughts = Character("Ava", color="#bdbdbd", image="ava")
# A name of her own, so it needs no badge to be unambiguous.
define ava_alter = Character("Ava Prime", color="#ffd6d6", image="ava_alter")

define ben = Character("Ben", color="#8fd0ff", image="ben")
define ben_thoughts = Character("Ben", color="#9ec4e0")

# A short variable with a longer display name.
define cora = Character("Cora Vale", color="#c4a7ff")
define cora_thoughts = Character("Cora Vale", color="#b09ae0")

define nico = Character("Nico", color="#a6e3a1")
define nico_memory = Character("Nico", color="#7fb98a")
# Reads as somebody else, so the suffix means nothing here.
define nico_unknown = Character("Stranger", color="#cccccc")

# A colour too dark to read on the writer ground, lifted when shown.
define dev = Character("Dev", color="#36393F", image="dev")
# Never drawn, so no expressions should be found for her.
define quinn = Character("Quinn", color="#8ec7a0")
define narrator = Character(None)

# Portraits. The writer learns a character's expressions from these, not
# from what happens to be sitting in the images folder.
image side ava = "portraits/ava_happy.png"
image side ava happy = "portraits/ava_happy.png"
image side ava sad = "portraits/ava_sad.png"
image side ava angry = "portraits/ava_angry.png"
image side ava smirk = "portraits/ava_smirk.png"
image side ava tired = "portraits/ava_tired.png"

image side ava_alter explaining = "portraits/ava_alter_explaining.png"
image side ava_alter quiet = "portraits/ava_alter_quiet.png"

image side ben thinking = "portraits/ben_thinking.png"
image side ben happy = "portraits/ben_happy.png"

image side dev flat = "portraits/dev_flat.png"


# Not every image is a file: a colour, and a video, both of which the
# writer has to recognise without trying to draw them in a preview.
image black = "#000"
image ep1_walk_anim = Movie(play="movies/ep1_walk.webm")

label start:
    jump chapter_1
