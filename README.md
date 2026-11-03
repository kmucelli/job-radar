# Job Radar

Job Radar finds network and IT jobs for you, scores each one against your CV,
and keeps track of your applications. It runs on your own computer: your CV and
your data never leave it.

It searches the job boards (justjoin.it, NoFluffJobs, pracuj.pl, LinkedIn,
BulldogJob and more, for Poland, Germany, the Netherlands and EU-remote) and the
career sites of 100 large employers in Poland.

## Install on Windows

1. **Download Job Radar.** Click the green **Code** button at the top of this
   page, choose **Download ZIP**, and unzip it, for example into
   `Documents\job-radar`.
2. **Run the setup.** Open the unzipped folder and double-click **`setup.cmd`**.
   - If Windows asks whether to run it, choose **Run** (or **More info** >
     **Run anyway**).
   - The setup installs [Bun](https://bun.sh), the only thing Job Radar needs,
     starts Job Radar, makes it start with Windows, and schedules a daily search
     at 09:00. When it is done, your browser opens **http://127.0.0.1:8899**.
3. **Upload your CV.** In the browser, click **Upload CV** and choose your CV
   (a PDF with selectable text).
4. **Search.** Click **Scrape Now**, or type a job title in **Smart Search**,
   click **Add**, then **Search**. Results appear after a few minutes.

That's it. Bookmark http://127.0.0.1:8899; Job Radar keeps running in the
background.

## Install on macOS or Linux

1. Open a terminal and run:

   ```bash
   git clone https://github.com/kmucelli/job-radar.git
   cd job-radar
   bash setup.sh
   ```

   It installs Bun if needed, starts Job Radar and opens http://127.0.0.1:8899.
2. Upload your CV and search, as in steps 3 and 4 above.

After a restart, run `bash setup.sh` again in the `job-radar` folder.

## Everyday use

| To... | Do this |
|---|---|
| Open Job Radar | Go to http://127.0.0.1:8899 |
| Search for other jobs | Smart Search: type a job title, **Add**, **Search** |
| Change the daily search | Edit `dashboard/config.json` (job titles, cities, job boards) |
| Update Job Radar | `git pull` in the folder, or download the ZIP again and copy its files over the old ones; then run the setup again |
| Stop and remove it | Windows: double-click `uninstall.cmd`, then delete the folder. macOS/Linux: `bash setup.sh --stop` |

## If something does not work

- **The page does not open:** run `setup.cmd` (or `bash setup.sh`) again.
- **A search finds nothing or fails:** look at `dashboard/data/scrape.log`.
- **No keywords appear after uploading the CV:** upload a PDF with selectable
  text, not a scan.

More details (how jobs are scored, every setting, all job sources):
[dashboard/README.md](dashboard/README.md).

## License

MIT, see [LICENSE](LICENSE). The job-board scrapers build on
[ai-job-search](https://github.com/MadsLorentzen/ai-job-search) by Mads
Lorentzen, also MIT (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
