# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 the Immage authors

include_directories(${DARKTABLE_BINDIR})

find_package(PkgConfig REQUIRED)
pkg_check_modules(JSON_GLIB REQUIRED json-glib-1.0)

add_executable(darktable-engine main.c upright.c)

set_target_properties(darktable-engine PROPERTIES LINKER_LANGUAGE C)

target_include_directories(darktable-engine PRIVATE ${JSON_GLIB_INCLUDE_DIRS})
target_link_directories(darktable-engine PRIVATE ${JSON_GLIB_LIBRARY_DIRS})
target_link_libraries(darktable-engine lib_darktable ${JSON_GLIB_LIBRARIES})

set_target_properties(darktable-engine
                      PROPERTIES
                      INSTALL_RPATH ${RPATH_ORIGIN}/${REL_BIN_TO_LIBDIR}
                      RUNTIME_OUTPUT_DIRECTORY ${DARKTABLE_BINDIR})

# a console program: the app talks to it over stdin and stdout, and starts
# it without a window
if(WIN32)
  set_target_properties(darktable-engine PROPERTIES LINK_FLAGS "-mconsole")
endif()

install(TARGETS darktable-engine DESTINATION ${CMAKE_INSTALL_BINDIR} COMPONENT DTApplication)
