# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a buildathon project repository (project5) that appears to be set up for Python development. The repository is currently minimal, containing only basic project setup files.

## Development Setup

Since this is a new Python project, common setup patterns would likely include:

- **Virtual Environment**: Create and activate a virtual environment (`python -m venv venv` then `source venv/bin/activate` on macOS/Linux or `venv\Scripts\activate` on Windows)
- **Dependencies**: Install dependencies with `pip install -r requirements.txt` (once requirements.txt is created)
- **Development Dependencies**: Consider using `pip install -e .` if setup.py is created, or modern tools like Poetry (`poetry install`) or UV

## Common Commands

Since no specific build system is configured yet, standard Python commands would apply:

- **Run Python scripts**: `python script_name.py`
- **Install packages**: `pip install package_name`
- **Run tests**: `python -m pytest` (if pytest is used) or `python -m unittest` (for standard library)
- **Format code**: `python -m black .` (if Black is used) or `python -m ruff format .` (if Ruff is used)
- **Lint code**: `python -m ruff check .` (if Ruff is used) or `python -m flake8` (if Flake8 is used)

## Project Structure

Currently minimal - the actual architecture will depend on what gets built during the buildathon. The .gitignore suggests support for various Python tools and frameworks including Django, Flask, Jupyter notebooks, and modern package managers.

## Development Notes

- The repository is set up with a comprehensive Python .gitignore that supports multiple development tools and environments
- This appears to be a rapid prototyping environment for a one-day buildathon competition
- Consider establishing coding standards and test frameworks early in development