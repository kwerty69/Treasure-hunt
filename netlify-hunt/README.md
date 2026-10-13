# QR Treasure Hunt (Netlify)

## Deploy once
1. Put this folder in a GitHub repo (github.com -> New repository -> "uploading an existing file", drag everything in).
2. Netlify -> Add new site -> Import from Git -> pick the repo. Leave build settings as they are.
3. Site configuration -> Environment variables -> add ADMIN_PASSWORD (your organiser password).
   Optional: SESSION_SECRET (any long random text).
4. Deploys -> Trigger deploy (so the variable takes effect).
5. Site configuration -> Change site name, to get a clean permanent link like https://mycollege-hunt.netlify.app

## Run the event
Open <your link>/admin, log in, then: add QR stations, add teams (+ passwords), build each team's route/clues.
Open /admin on your final link BEFORE printing the QR codes (the Stations tab has "Print all QR codes").
Everything is stored in Netlify Blobs; edits in the portal apply instantly, no redeploy needed.
