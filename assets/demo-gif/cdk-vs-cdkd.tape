# Real recording — actually deploys to AWS.
# cdkd finishes ~17s; cdk takes ~94s. Total recording 35s captures the
# cinemagraph moment: cdkd done with `time` proof, cdk still mid-deploy.

Output "../cdk-vs-cdkd.gif"

Set Theme        "Catppuccin Mocha"
Set FontFamily   "JetBrainsMono Nerd Font"
Set FontSize     18
Set Width        1800
Set Height       720
Set Padding      20
Set TypingSpeed  40ms
Set PlaybackSpeed 1.0

Hide
Type "export PS1='$ ' && clear"
Enter
Sleep 500ms
Show

Type "bash run.sh"
Enter

# cdkd ~17s; hold ~20s after to keep `time real 0m17.0s` clearly visible
# while cdk is still mid-deploy. Total visible duration ~35s.
Sleep 35s
